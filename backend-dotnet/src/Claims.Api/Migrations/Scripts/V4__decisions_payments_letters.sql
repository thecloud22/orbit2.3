-- V4: decisions (immutable versions), payment items and runs, letters.

-- A decision is locked when recorded. A change is a new version that supersedes the old one; rows are
-- never updated or deleted (trigger below).
CREATE TABLE decisions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        uuid NOT NULL REFERENCES claims (id),
    benefit_line_id uuid NOT NULL REFERENCES benefit_lines (id),
    version         integer NOT NULL,
    supersedes_id   uuid REFERENCES decisions (id),
    outcome         text NOT NULL,
    outcome_text    text NOT NULL,
    basis           text NOT NULL,
    evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
    provisions      jsonb NOT NULL DEFAULT '[]'::jsonb,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    recorded_by     uuid NOT NULL REFERENCES staff_users (id),
    authority_note  text NOT NULL,
    approved_by     uuid REFERENCES staff_users (id),
    approved_at     timestamptz,
    letter_template text,
    CONSTRAINT decisions_version_unique UNIQUE (benefit_line_id, version),
    CONSTRAINT decisions_version_ck CHECK (version >= 1 AND ((version = 1) = (supersedes_id IS NULL))),
    CONSTRAINT decisions_outcome_ck CHECK (outcome IN ('approved', 'approved_in_part', 'denied', 'closed')),
    CONSTRAINT decisions_approval_ck CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX decisions_claim_idx ON decisions (claim_id, recorded_at DESC);
CREATE TRIGGER decisions_locked BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The daily run that pays whatever is cleared. Independent of Temporal.
CREATE TABLE payment_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date      date NOT NULL,
    status        text NOT NULL DEFAULT 'building',
    trigger       text NOT NULL DEFAULT 'schedule',
    item_count    integer NOT NULL DEFAULT 0,
    total_amount  numeric(15,2) NOT NULL DEFAULT 0,
    currency      char(3) NOT NULL DEFAULT 'USD',
    file_reference text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    version       bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_runs_status_ck CHECK (status IN ('building', 'sent', 'reconciled', 'failed')),
    CONSTRAINT payment_runs_trigger_ck CHECK (trigger IN ('schedule', 'manual')),
    CONSTRAINT payment_runs_totals_ck CHECK (item_count >= 0 AND total_amount >= 0)
);
-- One scheduled run per day; manual runs are allowed alongside it.
CREATE UNIQUE INDEX payment_runs_one_scheduled_per_day ON payment_runs (run_date) WHERE trigger = 'schedule';
CREATE TRIGGER payment_runs_touch BEFORE UPDATE ON payment_runs FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Payment items are the contract between claims and payments.
--   awaiting_proof -> cleared -> in_run -> paid; also held, cancelled, returned.
-- Only the payment run touches an item that is in a run. Paid items are never edited; a correction is a
-- new item of kind 'adjustment' pointing at the item it corrects.
CREATE TABLE payment_items (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id         uuid NOT NULL REFERENCES claims (id),
    benefit_line_id  uuid NOT NULL REFERENCES benefit_lines (id),
    decision_id      uuid REFERENCES decisions (id),
    kind             text NOT NULL DEFAULT 'benefit',
    adjusts_item_id  uuid REFERENCES payment_items (id),
    payee_party_id   uuid NOT NULL REFERENCES parties (id),
    basis            text NOT NULL,
    principal_amount numeric(15,2) NOT NULL,
    interest_amount  numeric(15,2) NOT NULL DEFAULT 0,
    amount           numeric(15,2) GENERATED ALWAYS AS (principal_amount + interest_amount) STORED,
    currency         char(3) NOT NULL DEFAULT 'USD',
    method           text NOT NULL,
    pay_on           date NOT NULL,
    status           text NOT NULL DEFAULT 'awaiting_proof',
    hold_reason      text,
    run_id           uuid REFERENCES payment_runs (id),
    paid_at          timestamptz,
    version          bigint NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_items_kind_ck CHECK (kind IN ('benefit', 'adjustment')),
    CONSTRAINT payment_items_status_ck CHECK (status IN ('awaiting_proof', 'cleared', 'in_run', 'paid', 'held', 'cancelled', 'returned')),
    CONSTRAINT payment_items_method_ck CHECK (method IN ('eft', 'check')),
    CONSTRAINT payment_items_adjust_ck CHECK ((kind = 'adjustment') = (adjusts_item_id IS NOT NULL)),
    CONSTRAINT payment_items_amount_ck CHECK (kind = 'adjustment' OR (principal_amount >= 0 AND interest_amount >= 0)),
    CONSTRAINT payment_items_run_ck CHECK (status NOT IN ('in_run', 'paid') OR run_id IS NOT NULL),
    CONSTRAINT payment_items_paid_ck CHECK ((status = 'paid') = (paid_at IS NOT NULL) OR status = 'returned'),
    CONSTRAINT payment_items_hold_ck CHECK ((status = 'held') = (hold_reason IS NOT NULL)),
    -- One benefit item per decision, payee and line: re-running "create items" cannot pay twice.
    CONSTRAINT payment_items_once UNIQUE (decision_id, benefit_line_id, payee_party_id, kind)
);
-- What the run selects: cleared items due on or before the run date.
CREATE INDEX payment_items_cleared_idx ON payment_items (pay_on, id) WHERE status = 'cleared';
CREATE INDEX payment_items_claim_idx ON payment_items (claim_id);
CREATE INDEX payment_items_run_idx ON payment_items (run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER payment_items_touch BEFORE UPDATE ON payment_items FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Money on an item that is in a run or paid can no longer change, and paid items can only move to returned.
CREATE FUNCTION guard_payment_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('in_run', 'paid', 'returned') AND
       (NEW.principal_amount, NEW.interest_amount, NEW.payee_party_id, NEW.method, NEW.pay_on, NEW.claim_id, NEW.benefit_line_id)
       IS DISTINCT FROM
       (OLD.principal_amount, OLD.interest_amount, OLD.payee_party_id, OLD.method, OLD.pay_on, OLD.claim_id, OLD.benefit_line_id) THEN
        RAISE EXCEPTION 'payment item % is % and cannot be edited; create an adjustment item', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'returned') THEN
        RAISE EXCEPTION 'paid payment item % can only become returned', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER payment_items_guard BEFORE UPDATE ON payment_items FOR EACH ROW EXECUTE FUNCTION guard_payment_item();

-- Outbound correspondence. dedupe_key makes every send idempotent: an activity that is retried, or a
-- workflow started twice, inserts the same key and finds the letter already there.
CREATE TABLE letters (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id           uuid NOT NULL REFERENCES claims (id),
    benefit_line_id    uuid REFERENCES benefit_lines (id),
    template_code      text NOT NULL,
    channel            text NOT NULL,
    recipient_party_id uuid REFERENCES parties (id),
    recipient_label    text NOT NULL,
    subject            text NOT NULL,
    summary            text,
    status             text NOT NULL DEFAULT 'queued',
    sent_at            timestamptz,
    provider_message_id text,
    source_kind        text,
    source_id          uuid,
    workflow_id        text,
    dedupe_key         text NOT NULL,
    version            bigint NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT letters_dedupe_unique UNIQUE (dedupe_key),
    CONSTRAINT letters_channel_ck CHECK (channel IN ('letter', 'email', 'sms', 'portal', 'fax')),
    CONSTRAINT letters_status_ck CHECK (status IN ('draft', 'queued', 'sent', 'failed')),
    CONSTRAINT letters_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    CONSTRAINT letters_source_ck CHECK (source_kind IS NULL OR source_kind IN ('deadline', 'outbox_event', 'decision', 'user'))
);
CREATE INDEX letters_claim_idx ON letters (claim_id, created_at DESC);
CREATE TRIGGER letters_touch BEFORE UPDATE ON letters FOR EACH ROW EXECUTE FUNCTION touch_row();
