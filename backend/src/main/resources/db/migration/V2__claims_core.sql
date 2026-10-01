-- V2: the claim, its life-specific facts, who is involved, benefit lines and requirements.

CREATE SEQUENCE claim_number_seq START WITH 43310;   -- L-26-043310 in the mock story

CREATE TABLE claims (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_number    text NOT NULL UNIQUE,
    family          text NOT NULL,
    product_code    text NOT NULL,
    insured_party_id uuid NOT NULL REFERENCES parties (id),
    -- The claim state machine. received = notice saved, intake run has not finished set-up.
    status          text NOT NULL DEFAULT 'received',
    track           text,
    route_rule      text,
    route_reasons   text[] NOT NULL DEFAULT '{}',
    owner_id        uuid REFERENCES staff_users (id),
    team            text NOT NULL DEFAULT 'Life & annuity team',
    noticed_at      timestamptz NOT NULL,
    proof_complete_at timestamptz,
    closed_at       timestamptz,
    version         bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text NOT NULL,
    CONSTRAINT claims_number_ck CHECK (claim_number ~ '^[LDA]-[0-9]{2}-[0-9]{6}$'),
    CONSTRAINT claims_family_ck CHECK (family IN ('life', 'disability', 'annuity')),
    CONSTRAINT claims_status_ck CHECK (status IN ('received', 'gathering_evidence', 'in_review', 'awaiting_approval', 'approved', 'closed')),
    CONSTRAINT claims_track_ck CHECK (track IS NULL OR track IN ('fast_track_life', 'standard_life')),
    CONSTRAINT claims_closed_ck CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    -- Past 'received' a claim has been routed and has an owner.
    CONSTRAINT claims_routed_ck CHECK (status = 'received' OR (track IS NOT NULL AND route_rule IS NOT NULL))
);
CREATE INDEX claims_owner_status_idx ON claims (owner_id, status);
CREATE INDEX claims_created_idx ON claims (created_at DESC, id DESC);
CREATE INDEX claims_insured_idx ON claims (insured_party_id);
CREATE TRIGGER claims_touch BEFORE UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Facts only a life claim has. Disability and annuity get their own detail tables later.
CREATE TABLE life_claim_details (
    claim_id            uuid PRIMARY KEY REFERENCES claims (id),
    date_of_death       date NOT NULL,
    place_of_death      text,
    manner_of_death     text NOT NULL,
    death_outside_us    boolean NOT NULL DEFAULT false,
    funeral_home        text,
    caller_party_id     uuid NOT NULL REFERENCES parties (id),
    caller_relationship text,
    contact_by          text[] NOT NULL DEFAULT '{}',
    identity_verified   boolean NOT NULL,
    agent_consent       boolean NOT NULL DEFAULT false,
    other_claimants_possible boolean NOT NULL DEFAULT false,
    intake_channel      text NOT NULL DEFAULT 'phone',
    CONSTRAINT life_manner_ck CHECK (manner_of_death IN ('natural', 'accident', 'pending')),
    CONSTRAINT life_contact_ck CHECK (contact_by <@ ARRAY['email', 'text', 'phone', 'mail']),
    CONSTRAINT life_channel_ck CHECK (intake_channel IN ('phone', 'portal', 'mail', 'agent'))
);

CREATE TABLE claim_parties (
    claim_id      uuid NOT NULL REFERENCES claims (id),
    party_id      uuid NOT NULL REFERENCES parties (id),
    role          text NOT NULL,
    relationship  text,
    beneficiary_kind text,
    share_percent numeric(5,2),
    payee         boolean NOT NULL DEFAULT false,
    packet_channel text,
    access_note   text,
    status        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (claim_id, party_id, role),
    CONSTRAINT claim_parties_role_ck CHECK (role IN ('insured', 'owner', 'caller', 'claimant', 'beneficiary', 'agent_of_record', 'funeral_home')),
    CONSTRAINT claim_parties_kind_ck CHECK (beneficiary_kind IS NULL OR beneficiary_kind IN ('primary', 'contingent')),
    CONSTRAINT claim_parties_share_ck CHECK (share_percent IS NULL OR (share_percent > 0 AND share_percent <= 100)),
    CONSTRAINT claim_parties_packet_ck CHECK (packet_channel IS NULL OR packet_channel IN ('portal', 'mail')),
    CONSTRAINT claim_parties_bene_ck CHECK (role = 'beneficiary' OR (beneficiary_kind IS NULL AND share_percent IS NULL AND NOT payee))
);
CREATE INDEX claim_parties_party_idx ON claim_parties (party_id);

-- One row per coverage in play: the base policy, and each rider as its own line so it can be
-- decided and paid separately.
CREATE TABLE benefit_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        uuid NOT NULL REFERENCES claims (id),
    policy_id       uuid NOT NULL REFERENCES policies (id),
    kind            text NOT NULL,
    parent_line_id  uuid REFERENCES benefit_lines (id),
    rider_key       text,
    name            text NOT NULL,
    amount          numeric(15,2) NOT NULL,
    currency        char(3) NOT NULL DEFAULT 'USD',
    status          text NOT NULL DEFAULT 'gathering_evidence',
    waiting_on      text,
    -- Contract terms are pinned per benefit line (architecture: "Pinned per benefit line").
    product_config_version text NOT NULL,
    version         bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT benefit_lines_kind_ck CHECK (kind IN ('base', 'rider')),
    CONSTRAINT benefit_lines_rider_ck CHECK ((kind = 'rider') = (parent_line_id IS NOT NULL AND rider_key IS NOT NULL)),
    CONSTRAINT benefit_lines_status_ck CHECK (status IN ('gathering_evidence', 'cause_pending', 'not_payable', 'ready_to_decide', 'approved', 'paid', 'denied', 'closed')),
    CONSTRAINT benefit_lines_amount_ck CHECK (amount >= 0)
);
CREATE INDEX benefit_lines_claim_idx ON benefit_lines (claim_id);
CREATE UNIQUE INDEX benefit_lines_one_base_per_policy ON benefit_lines (claim_id, policy_id) WHERE kind = 'base';
CREATE TRIGGER benefit_lines_touch BEFORE UPDATE ON benefit_lines FOR EACH ROW EXECUTE FUNCTION touch_row();

-- The evidence a claim waits on. requested -> received -> accepted; not_enough goes back to being
-- chased; waived needs a reason; expired is set by the requirement expiry deadline (later).
CREATE TABLE requirements (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id         uuid NOT NULL REFERENCES claims (id),
    benefit_line_id  uuid REFERENCES benefit_lines (id),
    key              text NOT NULL,
    name             text NOT NULL,
    purpose          text NOT NULL,
    from_party_id    uuid REFERENCES parties (id),
    from_label       text NOT NULL,
    from_detail      text,
    state            text NOT NULL DEFAULT 'requested',
    requested_at     timestamptz NOT NULL,
    follow_up_days   integer NOT NULL DEFAULT 10,
    follow_up_count  integer NOT NULL DEFAULT 0,
    last_reminder_at timestamptz,
    received_at      timestamptz,
    accepted_at      timestamptz,
    satisfied_by     text,
    waived_at        timestamptz,
    waived_by        text,
    waive_reason     text,
    version          bigint NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT requirements_key_ck CHECK (key IN ('certificate', 'statement', 'primary_died_first', 'report', 'amended_certificate')),
    CONSTRAINT requirements_state_ck CHECK (state IN ('requested', 'received', 'accepted', 'not_enough', 'waived', 'expired')),
    CONSTRAINT requirements_follow_ck CHECK (follow_up_days >= 0 AND follow_up_count >= 0),
    CONSTRAINT requirements_accepted_ck CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
    CONSTRAINT requirements_waived_ck CHECK ((state = 'waived') = (waived_at IS NOT NULL AND waive_reason IS NOT NULL AND length(btrim(waive_reason)) > 0))
);
CREATE INDEX requirements_claim_idx ON requirements (claim_id, state);
CREATE TRIGGER requirements_touch BEFORE UPDATE ON requirements FOR EACH ROW EXECUTE FUNCTION touch_row();
