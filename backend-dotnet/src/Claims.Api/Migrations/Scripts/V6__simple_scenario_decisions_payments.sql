-- V6: what the simple life scenario needs on top of V1..V5 (decisions with approval, the payment run, the bank's answer).
-- Nothing here rewrites a row: it widens two checks, adds columns and one small table, and tightens the payment item guard.

-- The claim is `paying` while any of its items is in a payment run.
ALTER TABLE claims DROP CONSTRAINT claims_status_ck;
ALTER TABLE claims ADD CONSTRAINT claims_status_ck
    CHECK (status IN ('received', 'gathering_evidence', 'in_review', 'awaiting_approval', 'approved', 'paying', 'closed'));

-- A deadline row can be closed by the payment run (payment_due).
ALTER TABLE deadlines DROP CONSTRAINT deadlines_closed_by_ck;
ALTER TABLE deadlines ADD CONSTRAINT deadlines_closed_by_ck
    CHECK (closed_by IS NULL OR closed_by IN ('workflow', 'intake', 'requirement', 'decision', 'payment', 'user'));

-- Decisions stay immutable. What is added:
--   requires_approval  the recorded amount was above the recorder's authority, so the decision is `awaiting_approval` until approved.
--   group_id           decisions recorded in one act (the base line and its riders) share it, and one approval covers them all.
--   amount             proceeds plus interest, as computed when it was recorded (null when nothing is payable).
-- The approval itself is a separate append-only row, so the decision row is never updated.
ALTER TABLE decisions
    ADD COLUMN requires_approval boolean NOT NULL DEFAULT false,
    ADD COLUMN group_id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN amount numeric(15,2);
CREATE INDEX decisions_group_idx ON decisions (group_id);

CREATE TABLE decision_approvals (
    decision_id uuid PRIMARY KEY REFERENCES decisions (id),
    approved_by uuid NOT NULL REFERENCES staff_users (id),
    approved_at timestamptz NOT NULL,
    note        text
);
CREATE TRIGGER decision_approvals_append_only BEFORE UPDATE OR DELETE ON decision_approvals
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Payment items: the bank's reference for a paid item, its reason for a returned one, and a link from a replacement to the item it
-- replaces (built with the bank-returns scenario). A replacement is a new benefit item for the same decision, payee and line, so the
-- "once" rule now applies to originals only.
ALTER TABLE payment_items
    ADD COLUMN payment_reference text,
    ADD COLUMN return_code text,
    ADD COLUMN return_reason text,
    ADD COLUMN replacement_of_id uuid REFERENCES payment_items (id);
ALTER TABLE payment_items DROP CONSTRAINT payment_items_once;
CREATE UNIQUE INDEX payment_items_once ON payment_items (decision_id, benefit_line_id, payee_party_id, kind) WHERE replacement_of_id IS NULL;
CREATE INDEX payment_items_replacement_idx ON payment_items (replacement_of_id) WHERE replacement_of_id IS NOT NULL;

-- Once an item is in a run, paid or returned its money, payee and links are frozen; once paid or returned its run, payment date and
-- reference are frozen too; a paid item can only become returned, and a returned item is final (a replacement is a new item).
CREATE OR REPLACE FUNCTION guard_payment_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('in_run', 'paid', 'returned') AND
       (NEW.principal_amount, NEW.interest_amount, NEW.payee_party_id, NEW.method, NEW.pay_on, NEW.claim_id, NEW.benefit_line_id,
        NEW.decision_id, NEW.kind, NEW.adjusts_item_id, NEW.replacement_of_id)
       IS DISTINCT FROM
       (OLD.principal_amount, OLD.interest_amount, OLD.payee_party_id, OLD.method, OLD.pay_on, OLD.claim_id, OLD.benefit_line_id,
        OLD.decision_id, OLD.kind, OLD.adjusts_item_id, OLD.replacement_of_id) THEN
        RAISE EXCEPTION 'payment item % is % and cannot be edited; create an adjustment item', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'returned') THEN
        RAISE EXCEPTION 'paid payment item % can only become returned', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'returned' AND NEW.status <> 'returned' THEN
        RAISE EXCEPTION 'returned payment item % is final; issue a replacement item', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('paid', 'returned') AND
       (NEW.run_id, NEW.paid_at, NEW.payment_reference) IS DISTINCT FROM (OLD.run_id, OLD.paid_at, OLD.payment_reference) THEN
        RAISE EXCEPTION 'payment item % is % and cannot be edited; create an adjustment item', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;

-- Payment runs: an optional idempotency key (a repeat of a manual trigger returns the run), counts and the failure reason.
ALTER TABLE payment_runs
    ADD COLUMN idempotency_key text,
    ADD COLUMN paid_count integer NOT NULL DEFAULT 0,
    ADD COLUMN returned_count integer NOT NULL DEFAULT 0,
    ADD COLUMN error text;
CREATE UNIQUE INDEX payment_runs_idempotency_idx ON payment_runs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX payment_runs_started_idx ON payment_runs (started_at DESC, id DESC);

-- A repeated POST /claims/{id}/decisions finds the act it made.
ALTER TABLE idempotency_keys ADD COLUMN resource_id uuid;
