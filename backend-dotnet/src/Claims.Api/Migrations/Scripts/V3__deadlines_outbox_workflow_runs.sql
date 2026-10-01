-- V3: deadlines (what the dispatcher polls), the outbox, idempotency keys and workflow run records.

-- A deadline is a row, not a timer. Examiners see it, compliance reports on it, an extension is an
-- UPDATE with a reason, and the dispatcher fires it. States:
--   open        waiting for due_at (the dispatcher only looks at these)
--   dispatched  the dispatcher started deadline-<id>; the workflow closes it as done or skipped
--   done        the work happened (or the thing it guarded happened first)
--   skipped     the workflow re-checked and it no longer applied; `result` says why
CREATE TABLE deadlines (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id         uuid NOT NULL REFERENCES claims (id),
    kind             text NOT NULL,
    requirement_id   uuid REFERENCES requirements (id),
    what             text NOT NULL,
    sla              text,
    due_at           timestamptz NOT NULL,
    original_due_at  timestamptz NOT NULL,
    extension_reason text,
    state            text NOT NULL DEFAULT 'open',
    -- Dispatch bookkeeping. `attempt` counts dispatch attempts; retry_after backs a failed start off
    -- without moving the legal due_at.
    attempt          integer NOT NULL DEFAULT 0,
    retry_after      timestamptz,
    dispatched_at    timestamptz,
    fired            boolean NOT NULL DEFAULT false,
    last_outcome     text,
    last_error       text,
    -- Correlation with Temporal: workflow id is deadline-<id>.
    workflow_id      text,
    workflow_run_id  text,
    closed_at        timestamptz,
    closed_by        text,
    result           text,
    version          bigint NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT deadlines_kind_ck CHECK (kind IN ('acknowledge_by', 'forms_by', 'first_contact_by', 'status_letter',
                                                 'requirement_follow_up', 'decision_due', 'review_target', 'payment_due')),
    CONSTRAINT deadlines_state_ck CHECK (state IN ('open', 'dispatched', 'done', 'skipped')),
    CONSTRAINT deadlines_outcome_ck CHECK (last_outcome IS NULL OR last_outcome IN
        ('started', 'already_started', 'start_failed', 'completed', 'skipped', 'closed_early')),
    CONSTRAINT deadlines_attempt_ck CHECK (attempt >= 0),
    CONSTRAINT deadlines_follow_up_ck CHECK (kind <> 'requirement_follow_up' OR requirement_id IS NOT NULL),
    -- closed_at is set exactly when the row is finished.
    CONSTRAINT deadlines_closed_ck CHECK ((state IN ('done', 'skipped')) = (closed_at IS NOT NULL)),
    CONSTRAINT deadlines_result_ck CHECK (state IN ('open', 'dispatched') OR (result IS NOT NULL AND closed_by IS NOT NULL)),
    CONSTRAINT deadlines_dispatched_ck CHECK (state <> 'dispatched' OR (attempt > 0 AND dispatched_at IS NOT NULL)),
    CONSTRAINT deadlines_closed_by_ck CHECK (closed_by IS NULL OR closed_by IN ('workflow', 'intake', 'requirement', 'decision', 'user')),
    -- Moving due_at needs a reason, and the original date is never lost.
    CONSTRAINT deadlines_extension_ck CHECK (due_at = original_due_at OR extension_reason IS NOT NULL)
);

-- THE index the dispatcher polls: only open rows, ordered by due date. It stays tiny however many rows
-- are closed, so the every-minute poll is an index range scan on a handful of entries.
CREATE INDEX deadlines_dispatch_idx ON deadlines (due_at, id) WHERE state = 'open';
-- Nightly check: dispatched rows that have not closed.
CREATE INDEX deadlines_stuck_idx ON deadlines (dispatched_at) WHERE state = 'dispatched';
CREATE INDEX deadlines_claim_idx ON deadlines (claim_id, due_at);
CREATE INDEX deadlines_requirement_idx ON deadlines (requirement_id) WHERE requirement_id IS NOT NULL;
-- At most one live follow-up per requirement, and one live status letter per claim. This is what makes
-- "write the next row" safe to repeat: a second insert fails instead of duplicating the chase.
CREATE UNIQUE INDEX deadlines_one_live_follow_up ON deadlines (requirement_id)
    WHERE kind = 'requirement_follow_up' AND state IN ('open', 'dispatched');
CREATE UNIQUE INDEX deadlines_one_live_status_letter ON deadlines (claim_id)
    WHERE kind = 'status_letter' AND state IN ('open', 'dispatched');
CREATE TRIGGER deadlines_touch BEFORE UPDATE ON deadlines FOR EACH ROW EXECUTE FUNCTION touch_row();

-- One line per dispatch attempt, append-only: what the dispatcher did and what came back.
CREATE TABLE deadline_attempts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deadline_id uuid NOT NULL REFERENCES deadlines (id),
    attempt     integer NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    outcome     text NOT NULL,
    workflow_id text,
    error       text,
    CONSTRAINT deadline_attempts_outcome_ck CHECK (outcome IN ('started', 'already_started', 'start_failed'))
);
CREATE INDEX deadline_attempts_deadline_idx ON deadline_attempts (deadline_id, attempt);
CREATE TRIGGER deadline_attempts_append_only BEFORE UPDATE OR DELETE ON deadline_attempts
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Work to do after a change, saved in the same transaction as the change. The relay starts the workflow
-- and stamps published_at. Workflow id derives from the event, so a second start is a no-op.
CREATE TABLE outbox_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    claim_id         uuid REFERENCES claims (id),
    event_type       text NOT NULL,
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    published_at     timestamptz,
    publish_attempts integer NOT NULL DEFAULT 0,
    retry_after      timestamptz,
    last_error       text,
    workflow_id      text,
    CONSTRAINT outbox_type_ck CHECK (event_type IN ('notice_of_death_received', 'document_received', 'decision_recorded', 'items_paid'))
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at, id) WHERE published_at IS NULL;

-- Idempotency-Key handling for POSTs that create things. A repeat with the same key and the same body
-- returns the claim it created; the same key with a different body is rejected. Written in the same
-- transaction as the change, so a key exists if and only if its claim does.
CREATE TABLE idempotency_keys (
    scope        text NOT NULL,
    key          text NOT NULL,
    request_hash text NOT NULL,
    claim_id     uuid NOT NULL REFERENCES claims (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, key),
    CONSTRAINT idempotency_key_length_ck CHECK (length(key) BETWEEN 8 AND 128)
);

-- What each workflow run did, as the Workflow & SLA section shows it. Written by the workflow's
-- activities; the run's results and its state change share one transaction.
CREATE TABLE workflow_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id   text NOT NULL,
    run_id        text NOT NULL,
    type          text NOT NULL,
    name          text NOT NULL,
    claim_id      uuid REFERENCES claims (id),
    started_by    text NOT NULL,
    trigger_kind  text,
    trigger_id    uuid,
    status        text NOT NULL DEFAULT 'running',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
    saved         text[] NOT NULL DEFAULT '{}',
    error         text,
    CONSTRAINT workflow_runs_unique UNIQUE (workflow_id, run_id),
    CONSTRAINT workflow_runs_type_ck CHECK (type IN ('orchestration', 'event', 'deadline')),
    CONSTRAINT workflow_runs_status_ck CHECK (status IN ('running', 'completed', 'skipped', 'needs_review', 'failed')),
    CONSTRAINT workflow_runs_trigger_ck CHECK (trigger_kind IS NULL OR trigger_kind IN ('outbox_event', 'deadline')),
    CONSTRAINT workflow_runs_finished_ck CHECK ((status = 'running') = (finished_at IS NULL)),
    CONSTRAINT workflow_runs_steps_ck CHECK (jsonb_typeof(steps) = 'array')
);
CREATE INDEX workflow_runs_claim_idx ON workflow_runs (claim_id, started_at);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id);
