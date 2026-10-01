package com.example.claims.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.claims.common.Actor;
import com.example.claims.intake.LifeIntakeService;
import com.example.claims.support.PostgresTestSupport;
import com.example.claims.support.RecordingLauncher;
import com.example.claims.support.RequiresPostgres;
import com.example.claims.support.TestData;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** REQUIRES POSTGRES. The constraints, triggers and indexes that make the rules hold whoever writes the rows. */
@RequiresPostgres
@SpringBootTest
@ActiveProfiles("test")
class SchemaConstraintsPostgresTest {

    @TestConfiguration
    static class Config {
        @Bean @Primary RecordingLauncher launcher() { return new RecordingLauncher(); }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        PostgresTestSupport.register(registry, "schema");
    }

    @Autowired JdbcClient jdbc;
    @Autowired LifeIntakeService intake;

    private UUID claim() {
        var claim = intake.submit(TestData.castellano("natural", "WL-" + UUID.randomUUID().toString().substring(0, 8), "Schema Person", true),
                "key-" + UUID.randomUUID(), Actor.user("test")).claim();
        return claim.id();
    }

    @Test
    void migrationsCreatedEveryTableTheSliceNeeds() {
        assertThat(jdbc.sql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'").query(String.class).list())
                .contains("claims", "parties", "policies", "benefit_lines", "requirements", "deadlines", "deadline_attempts", "decisions",
                        "payment_items", "payment_runs", "letters", "history_events", "work_items", "workflow_runs", "outbox_events",
                        "idempotency_keys", "life_claim_details", "claim_parties", "staff_users", "flyway_schema_history");
    }

    @Test
    void historyIsAppendOnly() {
        UUID claim = claim();
        assertThat(jdbc.sql("SELECT count(*) FROM history_events WHERE claim_id = :c").param("c", claim).query(Integer.class).single()).isEqualTo(2);
        assertThatThrownBy(() -> jdbc.sql("UPDATE history_events SET title = 'edited' WHERE claim_id = :c").param("c", claim).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("DELETE FROM history_events WHERE claim_id = :c").param("c", claim).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("TRUNCATE history_events").update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
    }

    @Test
    void decisionsAreLockedAndVersionedNotEdited() {
        UUID claim = claim();
        UUID line = jdbc.sql("SELECT id FROM benefit_lines WHERE claim_id = :c AND kind = 'base'").param("c", claim).query(UUID.class).single();
        UUID staff = jdbc.sql("INSERT INTO staff_users (handle, display_name, team, role, payout_limit) VALUES (:h, 'Rachel', 'Life', 'life_examiner', 250000) RETURNING id")
                .param("h", "r-" + UUID.randomUUID()).query(UUID.class).single();
        UUID v1 = jdbc.sql("""
                INSERT INTO decisions (claim_id, benefit_line_id, version, outcome, outcome_text, basis, recorded_by, authority_note)
                VALUES (:c, :l, 1, 'approved', 'Approved', 'In force', :s, 'within authority') RETURNING id""")
                .param("c", claim).param("l", line).param("s", staff).query(UUID.class).single();

        assertThatThrownBy(() -> jdbc.sql("UPDATE decisions SET outcome = 'denied' WHERE id = :id").param("id", v1).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        // Version 1 has no predecessor; version 2 must supersede something; the pair is unique.
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO decisions (claim_id, benefit_line_id, version, outcome, outcome_text, basis, recorded_by, authority_note)
                VALUES (:c, :l, 2, 'denied', 'Denied', 'x', :s, 'x')""").param("c", claim).param("l", line).param("s", staff).update())
                .isInstanceOf(DataAccessException.class);
        jdbc.sql("""
                INSERT INTO decisions (claim_id, benefit_line_id, version, supersedes_id, outcome, outcome_text, basis, recorded_by, authority_note)
                VALUES (:c, :l, 2, :prev, 'approved_in_part', 'Part', 'corrected', :s, 'x')""")
                .param("c", claim).param("l", line).param("prev", v1).param("s", staff).update();
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO decisions (claim_id, benefit_line_id, version, supersedes_id, outcome, outcome_text, basis, recorded_by, authority_note)
                VALUES (:c, :l, 2, :prev, 'denied', 'dup', 'x', :s, 'x')""")
                .param("c", claim).param("l", line).param("prev", v1).param("s", staff).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("decisions_version_unique");
    }

    @Test
    void oneLiveFollowUpPerRequirementSoWritingTheNextRowTwiceFails() {
        UUID claim = claim();
        UUID req = jdbc.sql("SELECT r.id FROM requirements r WHERE r.claim_id = :c AND r.state = 'requested' LIMIT 1").param("c", claim).query(UUID.class).single();
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO deadlines (claim_id, kind, requirement_id, what, due_at, original_due_at)
                VALUES (:c, 'requirement_follow_up', :r, 'second live row', now(), now())""").param("c", claim).param("r", req).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("deadlines_one_live_follow_up");
    }

    @Test
    void movingADueDateNeedsAReasonAndTheOriginalIsKept() {
        UUID claim = claim();
        UUID d = jdbc.sql("SELECT id FROM deadlines WHERE claim_id = :c AND kind = 'acknowledge_by'").param("c", claim).query(UUID.class).single();
        assertThatThrownBy(() -> jdbc.sql("UPDATE deadlines SET due_at = due_at + interval '5 days' WHERE id = :id").param("id", d).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("deadlines_extension_ck");
        jdbc.sql("UPDATE deadlines SET due_at = due_at + interval '5 days', extension_reason = 'Claimant asked for time' WHERE id = :id").param("id", d).update();
        assertThat(jdbc.sql("SELECT due_at - original_due_at FROM deadlines WHERE id = :id").param("id", d).query(String.class).single()).isEqualTo("5 days");
    }

    @Test
    void aFinishedDeadlineNeedsAResultAndWhoClosedIt() {
        UUID claim = claim();
        UUID d = jdbc.sql("SELECT id FROM deadlines WHERE claim_id = :c AND kind = 'forms_by'").param("c", claim).query(UUID.class).single();
        assertThatThrownBy(() -> jdbc.sql("UPDATE deadlines SET state = 'done', closed_at = now() WHERE id = :id").param("id", d).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("deadlines_result_ck");
        assertThatThrownBy(() -> jdbc.sql("UPDATE deadlines SET state = 'dispatched' WHERE id = :id").param("id", d).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("deadlines_dispatched_ck");
    }

    @Test
    void everyMutableRowBumpsItsVersionOnAnyUpdate() {
        UUID claim = claim();
        long before = jdbc.sql("SELECT version FROM claims WHERE id = :c").param("c", claim).query(Long.class).single();
        jdbc.sql("UPDATE claims SET team = 'Other team' WHERE id = :c").param("c", claim).update();   // a plain SQL fix, not the app
        assertThat(jdbc.sql("SELECT version FROM claims WHERE id = :c").param("c", claim).query(Long.class).single()).isEqualTo(before + 1);
    }

    @Test
    void aWaivedRequirementNeedsAReasonAndAPaidPaymentItemCannotBeEdited() {
        UUID claim = claim();
        UUID req = jdbc.sql("SELECT id FROM requirements WHERE claim_id = :c AND state = 'requested' LIMIT 1").param("c", claim).query(UUID.class).single();
        assertThatThrownBy(() -> jdbc.sql("UPDATE requirements SET state = 'waived', waived_at = now() WHERE id = :id").param("id", req).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("requirements_waived_ck");

        UUID line = jdbc.sql("SELECT id FROM benefit_lines WHERE claim_id = :c AND kind = 'base'").param("c", claim).query(UUID.class).single();
        UUID payee = jdbc.sql("SELECT party_id FROM claim_parties WHERE claim_id = :c AND payee LIMIT 1").param("c", claim).query(UUID.class).single();
        UUID run = jdbc.sql("INSERT INTO payment_runs (run_date) VALUES (current_date) RETURNING id").query(UUID.class).single();
        UUID item = jdbc.sql("""
                INSERT INTO payment_items (claim_id, benefit_line_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status, run_id, paid_at)
                VALUES (:c, :l, :p, '50% of proceeds', 100000.00, 191.78, 'eft', current_date, 'paid', :r, now()) RETURNING id""")
                .param("c", claim).param("l", line).param("p", payee).param("r", run).query(UUID.class).single();
        assertThat(jdbc.sql("SELECT amount::text FROM payment_items WHERE id = :id").param("id", item).query(String.class).single()).isEqualTo("100191.78");
        assertThatThrownBy(() -> jdbc.sql("UPDATE payment_items SET principal_amount = 1 WHERE id = :id").param("id", item).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("cannot be edited");
        assertThatThrownBy(() -> jdbc.sql("UPDATE payment_items SET status = 'cleared', paid_at = NULL, run_id = NULL WHERE id = :id").param("id", item).update())
                .isInstanceOf(DataAccessException.class).hasMessageContaining("can only become returned");
    }
}
