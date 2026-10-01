-- V1: shared helpers, staff, parties and policies.
--
-- Conventions used in every migration:
--   * Primary keys are uuid (gen_random_uuid(), built in since PostgreSQL 13). Human references
--     (claim number) are separate unique columns.
--   * "Enums" are text columns with a named CHECK constraint, not CREATE TYPE ... AS ENUM: a check can be
--     dropped and re-added in one migration; an enum value can never be removed.
--   * Money is numeric(15,2) with a currency column. Never float.
--   * Every timestamp is timestamptz (UTC on the wire). Business dates (date of death, issue date) are date.
--   * Mutable rows carry `version` (optimistic concurrency, bumped by trigger so that every writer,
--     including workflows and hand-run SQL, bumps it), plus created_at / updated_at.

CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed: rows are append-only', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TABLE staff_users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle       text NOT NULL UNIQUE,
    display_name text NOT NULL,
    title        text,
    team         text NOT NULL,
    role         text NOT NULL,
    -- Largest single payout this person can approve alone (see decisions; authority is not built yet).
    payout_limit numeric(15,2) NOT NULL DEFAULT 0,
    active       boolean NOT NULL DEFAULT true,
    version      bigint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_users_role_ck CHECK (role IN ('life_examiner', 'di_case_manager', 'annuity_specialist', 'team_lead')),
    CONSTRAINT staff_users_limit_ck CHECK (payout_limit >= 0)
);
CREATE TRIGGER staff_users_touch BEFORE UPDATE ON staff_users FOR EACH ROW EXECUTE FUNCTION touch_row();

-- A person or organisation. Deliberately claim-agnostic so a later party master can merge duplicates;
-- the role a party plays on a claim lives in claim_parties.
CREATE TABLE parties (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL DEFAULT 'person',
    full_name    text NOT NULL,
    date_of_birth date,
    date_of_death date,
    death_source text,
    ssn_last4    char(4),
    email        text,
    phone        text,
    address      text,
    version      bigint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT parties_kind_ck CHECK (kind IN ('person', 'organisation')),
    CONSTRAINT parties_ssn_ck CHECK (ssn_last4 IS NULL OR ssn_last4 ~ '^[0-9]{4}$'),
    CONSTRAINT parties_dates_ck CHECK (date_of_death IS NULL OR date_of_birth IS NULL OR date_of_death >= date_of_birth),
    CONSTRAINT parties_person_only_ck CHECK (kind = 'person' OR (date_of_birth IS NULL AND date_of_death IS NULL AND ssn_last4 IS NULL))
);
CREATE INDEX parties_name_idx ON parties (lower(full_name));
CREATE TRIGGER parties_touch BEFORE UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION touch_row();

-- The claims-relevant snapshot of a policy from policy administration (the system of record for the
-- policy). Upserted by policy number at intake; `as_of` says how fresh the snapshot is.
CREATE TABLE policies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_number text NOT NULL UNIQUE,
    family        text NOT NULL,
    product_code  text NOT NULL,
    product_name  text NOT NULL,
    issue_date    date NOT NULL,
    paid_to_date  date NOT NULL,
    in_force      boolean NOT NULL,
    lapsed_on     date,
    face_amount   numeric(15,2) NOT NULL,
    currency      char(3) NOT NULL DEFAULT 'USD',
    source        text NOT NULL DEFAULT 'policy administration',
    as_of         timestamptz NOT NULL DEFAULT now(),
    version       bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT policies_family_ck CHECK (family IN ('life', 'disability', 'annuity')),
    CONSTRAINT policies_face_ck CHECK (face_amount >= 0),
    CONSTRAINT policies_lapse_ck CHECK (in_force = (lapsed_on IS NULL))
);
CREATE TRIGGER policies_touch BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE policy_riders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id  uuid NOT NULL REFERENCES policies (id),
    rider_key  text NOT NULL,
    name       text NOT NULL,
    amount     numeric(15,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT policy_riders_amount_ck CHECK (amount >= 0),
    CONSTRAINT policy_riders_unique UNIQUE (policy_id, rider_key)
);
