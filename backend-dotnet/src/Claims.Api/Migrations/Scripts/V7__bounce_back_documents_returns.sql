-- V7: what the complex "things bounce back" life scenario needs on top of V1..V6. V1..V6 are untouched.
-- Nothing here rewrites an existing row: it widens four checks, adds columns and three small tables.
--
--   * documents that arrive for a requirement (and the review of one the rules cannot accept)
--   * a claim that REOPENS after a bank return (status `reopened`), and closes again when the replacement item is paid
--   * two deadline kinds, `document_review_by` and `bank_details_by`. They have NO workflow of their own: they are target rows a person (or the
--     payee's own action) closes, and the nightly overdue check raises them to a person when they are late.
--   * a payee's payment method, and a hold on the closed account a returned payment went to
--   * workflow run records that carry a run number (an ops re-run is `run 2`), "what Temporal did" and the time the run took

-- ---------------------------------------------------------------------------------------------------------------- claim status
ALTER TABLE claims DROP CONSTRAINT claims_status_ck;
ALTER TABLE claims ADD CONSTRAINT claims_status_ck
    CHECK (status IN ('received', 'gathering_evidence', 'in_review', 'awaiting_approval', 'approved', 'paying', 'closed', 'reopened'));

-- ---------------------------------------------------------------------------------------------------------------- outbox events
ALTER TABLE outbox_events DROP CONSTRAINT outbox_type_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_type_ck
    CHECK (event_type IN ('notice_of_death_received', 'document_received', 'decision_recorded', 'items_paid',
                          'document_rejected', 'payment_returned', 'payment_method_updated'));

-- ---------------------------------------------------------------------------------------------------------------- requirements
-- Why a requirement is in its state when that is not obvious: `not_enough` "TIN mismatch", `received` "Under review: photocopy".
ALTER TABLE requirements ADD COLUMN state_note text;

-- ---------------------------------------------------------------------------------------------------------------- documents
-- A document that arrived for a requirement. The row is saved with an outbox event `document_received` (one transaction); a short workflow decides
-- what to do with it. `status`:
--   received      saved, no decision yet
--   accepted      the rules (or the examiner) accepted it; the requirement was accepted with it
--   not_enough    the IRS check answered "no match" (a W-9 whose taxpayer number does not match)
--   under_review  the rules cannot accept it (a photocopied certificate): a person decides
--   rejected      the examiner rejected it
-- The taxpayer number is kept only for the check; the API shows the last 4 digits.
CREATE TABLE documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        uuid NOT NULL REFERENCES claims (id),
    requirement_id  uuid REFERENCES requirements (id),
    party_id        uuid REFERENCES parties (id),
    kind            text NOT NULL,
    source          text NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'received',
    status_note     text,
    received_at     timestamptz NOT NULL,
    received_by     text NOT NULL,
    reviewed_by     text,
    reviewed_at     timestamptz,
    review_reason   text,
    outbox_event_id uuid REFERENCES outbox_events (id),
    version         bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT documents_kind_ck CHECK (kind IN ('claimant_statement_w9', 'death_certificate', 'police_report', 'other')),
    CONSTRAINT documents_source_ck CHECK (source IN ('portal', 'mail_room', 'upload')),
    CONSTRAINT documents_status_ck CHECK (status IN ('received', 'accepted', 'not_enough', 'under_review', 'rejected')),
    CONSTRAINT documents_attributes_ck CHECK (jsonb_typeof(attributes) = 'object'),
    CONSTRAINT documents_reviewed_ck CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX documents_claim_idx ON documents (claim_id, received_at, id);
CREATE INDEX documents_requirement_idx ON documents (requirement_id) WHERE requirement_id IS NOT NULL;
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------------------------------------------------------------------------------------------------------------- deadlines
ALTER TABLE deadlines DROP CONSTRAINT deadlines_kind_ck;
ALTER TABLE deadlines ADD CONSTRAINT deadlines_kind_ck CHECK (kind IN ('acknowledge_by', 'forms_by', 'first_contact_by', 'status_letter',
    'requirement_follow_up', 'decision_due', 'review_target', 'payment_due', 'document_review_by', 'bank_details_by'));
-- What a row is about when it is not a requirement: the document to review, the payee whose new details we wait for.
ALTER TABLE deadlines
    ADD COLUMN document_id uuid REFERENCES documents (id),
    ADD COLUMN party_id    uuid REFERENCES parties (id);
CREATE INDEX deadlines_document_idx ON deadlines (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX deadlines_party_idx ON deadlines (claim_id, party_id) WHERE party_id IS NOT NULL;

-- The nightly overdue check raises a late row to a person with a work item (dedupe key `overdue:<row id>`). When the row closes, by whatever closes it (the welcome call, the decision,
-- the payment run, a review, the payee's new account), that work item is done too: nobody should be chasing a row that is met.
CREATE FUNCTION complete_overdue_work_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE work_items SET status = 'done', completed_at = COALESCE(NEW.closed_at, now())
    WHERE dedupe_key = 'overdue:' || NEW.id AND status = 'open';
    RETURN NEW;
END $$;
CREATE TRIGGER deadlines_overdue_done AFTER UPDATE OF state ON deadlines FOR EACH ROW
    WHEN (NEW.state IN ('done', 'skipped') AND OLD.state IN ('open', 'dispatched')) EXECUTE FUNCTION complete_overdue_work_item();

-- ---------------------------------------------------------------------------------------------------------------- payment methods and holds
-- A payee's new account (only the last 4 digits of the routing and account numbers are kept). `pending_verification` until the bank check says
-- otherwise.
CREATE TABLE payment_methods (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id      uuid NOT NULL REFERENCES parties (id),
    claim_id      uuid NOT NULL REFERENCES claims (id),
    kind          text NOT NULL DEFAULT 'eft',
    routing_last4 char(4) NOT NULL,
    account_last4 char(4) NOT NULL,
    holder_name   text,
    status        text NOT NULL DEFAULT 'pending_verification',
    verified_at   timestamptz,
    version       bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payment_methods_kind_ck CHECK (kind IN ('eft')),
    CONSTRAINT payment_methods_status_ck CHECK (status IN ('pending_verification', 'verified', 'rejected')),
    CONSTRAINT payment_methods_last4_ck CHECK (routing_last4 ~ '^[0-9]{4}$' AND account_last4 ~ '^[0-9]{4}$'),
    CONSTRAINT payment_methods_verified_ck CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
CREATE INDEX payment_methods_claim_idx ON payment_methods (claim_id, party_id, created_at);
CREATE TRIGGER payment_methods_touch BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION touch_row();

-- The bank returned a payment: the account it went to (the one on file at intake, `payment_method_id IS NULL` on the item) is closed. While the
-- hold exists no cleared item of that payee on that claim that pays to the account on file is picked up by a payment run (the run's claim statement
-- checks it). One hold per returned item: the returns batch is safe to repeat. A new account does not lift it: the closed account stays closed; the
-- new account is recorded in `superseded_by_method_id` and items that pay to it are not affected.
CREATE TABLE payment_method_holds (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id                uuid NOT NULL REFERENCES parties (id),
    claim_id                uuid NOT NULL REFERENCES claims (id),
    source_item_id          uuid NOT NULL UNIQUE REFERENCES payment_items (id),
    reason                  text NOT NULL,
    superseded_by_method_id uuid REFERENCES payment_methods (id),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_method_holds_party_idx ON payment_method_holds (claim_id, party_id);

-- A returned item is replaced at most once (the unique index is what makes "create the replacement" safe to repeat).
CREATE UNIQUE INDEX payment_items_one_replacement ON payment_items (replacement_of_id) WHERE replacement_of_id IS NOT NULL;

-- Which account an item pays to. NULL is the account on file at intake. A replacement item points at the payee's new method.
ALTER TABLE payment_items ADD COLUMN payment_method_id uuid REFERENCES payment_methods (id);

-- ---------------------------------------------------------------------------------------------------------------- workflow runs
-- run_no / rerun_of_id: an ops re-run of a failed run is a NEW run of the same workflow id ("run 2"), linked to the failed one.
-- note: "what Temporal did", in plain words. elapsed_ms: real time from Begin to Finish (opened_real_at is real time on purpose: the business clock may
-- be virtual, and how long a run took is a fact about the machine).
ALTER TABLE workflow_runs
    ADD COLUMN run_no          integer NOT NULL DEFAULT 1,
    ADD COLUMN rerun_of_id     uuid REFERENCES workflow_runs (id),
    ADD COLUMN note            text,
    ADD COLUMN elapsed_ms      integer,
    ADD COLUMN opened_real_at  timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT workflow_runs_run_no_ck CHECK (run_no >= 1);
CREATE INDEX workflow_runs_status_idx ON workflow_runs (status, started_at DESC);
