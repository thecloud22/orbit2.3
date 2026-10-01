package com.example.claims.db;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.claims.common.Actor;
import com.example.claims.config.ClaimsProperties;
import com.example.claims.deadline.DeadlineDispatcher;
import com.example.claims.gateway.SanctionsGateway;
import com.example.claims.intake.LifeIntakeService;
import com.example.claims.outbox.OutboxRelay;
import com.example.claims.requirement.RequirementService;
import com.example.claims.support.PostgresTestSupport;
import com.example.claims.support.RequiresPostgres;
import com.example.claims.support.TestData;
import com.example.claims.temporal.LifeIntakeActivitiesImpl;
import com.example.claims.temporal.LifeIntakeWorkflow;
import com.example.claims.temporal.RequirementFollowUpActivities;
import com.example.claims.temporal.RequirementFollowUpActivitiesImpl;
import com.example.claims.temporal.TemporalConfig;
import com.example.claims.temporal.TemporalWorkflowLauncher;
import com.example.claims.temporal.WorkflowLauncher;
import com.example.claims.view.Views.ClaimView;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * REQUIRES POSTGRES. The whole slice together: real Spring beans, real SQL, real activities, the real launcher code,
 * and Temporal's in-process test server with time skipping. Nothing here fakes a database or the workflow logic;
 * only the outside systems (sanctions, notifications) are stubs, and sanctions times out once to show the retry.
 */
@RequiresPostgres
@SpringBootTest
@ActiveProfiles("test")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class LifeClaimFlowPostgresTest {

    static final AtomicInteger sanctionsCalls = new AtomicInteger();

    @TestConfiguration
    static class Config {
        @Bean(destroyMethod = "close")
        TestWorkflowEnvironment temporal(LifeIntakeActivitiesImpl intake, RequirementFollowUpActivitiesImpl followUp) {
            TestWorkflowEnvironment env = TestWorkflowEnvironment.newInstance();
            Worker worker = env.newWorker("claims");
            // The dispatcher workflow is not run here (the test calls dispatchDue() itself), so its activities are not registered;
            // registering them would make the dispatcher, the launcher and this environment depend on each other.
            TemporalConfig.registerAll(worker, intake, followUp);
            env.start();
            return env;
        }

        @Bean
        @Primary
        WorkflowLauncher launcher(TestWorkflowEnvironment env, ClaimsProperties props) {
            return new TemporalWorkflowLauncher(env.getWorkflowClient(), props);   // the production launcher, on the test server
        }

        @Bean
        @Primary
        SanctionsGateway sanctions() {
            return names -> {
                if (sanctionsCalls.incrementAndGet() == 1) throw new IllegalStateException("sanctions service timed out");
                return new SanctionsGateway.Screening(true, "ref-ok");
            };
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        PostgresTestSupport.register(registry, "flow");
    }

    @Autowired JdbcClient jdbc;
    @Autowired LifeIntakeService intake;
    @Autowired OutboxRelay relay;
    @Autowired DeadlineDispatcher dispatcher;
    @Autowired RequirementService requirements;
    @Autowired TestWorkflowEnvironment temporal;

    static UUID claimId;
    static String claimNumber;
    static UUID rachel;

    private <T> T one(String sql, Class<T> type, Object... args) {
        var spec = jdbc.sql(sql);
        for (int i = 0; i < args.length; i++) spec = spec.param(i + 1, args[i]);
        return spec.query(type).single();
    }

    private <T> T result(String workflowId, Class<T> type) {
        WorkflowStub stub = temporal.getWorkflowClient().newUntypedWorkflowStub(workflowId);
        return stub.getResult(type);
    }

    private UUID requirementId(String namePart) {
        return one("SELECT id FROM requirements WHERE claim_id = ? AND name LIKE ?", UUID.class, claimId, "%" + namePart + "%");
    }

    private UUID followUpFor(UUID requirement) {
        return one("SELECT id FROM deadlines WHERE requirement_id = ? AND state IN ('open', 'dispatched')", UUID.class, requirement);
    }

    private void makeDue(UUID deadline) {
        jdbc.sql("UPDATE deadlines SET due_at = now() - interval '1 minute', original_due_at = now() - interval '1 minute' WHERE id = :id").param("id", deadline).update();
    }

    @Test
    @Order(1)
    void submitCommitsAndReturnsBeforeAnyWorkflowRuns() {
        rachel = jdbc.sql("INSERT INTO staff_users (handle, display_name, team, role, payout_limit) VALUES ('rachel', 'Rachel Kim', 'Life & annuity team', 'life_examiner', 250000) RETURNING id")
                .query(UUID.class).single();

        ClaimView claim = intake.submit(TestData.castellano("natural"), "flow-" + UUID.randomUUID(), Actor.user("diane.intake")).claim();
        claimId = claim.id();
        claimNumber = claim.claimNumber();

        assertThat(claim.status()).isEqualTo("received");
        assertThat(one("SELECT count(*) FROM workflow_runs WHERE claim_id = ?", Integer.class, claimId)).isZero();
        assertThat(one("SELECT count(*) FROM letters WHERE claim_id = ?", Integer.class, claimId)).isZero();
    }

    @Test
    @Order(2)
    void outboxRelayStartsTheIntakeOrchestrationAndItSetsTheClaimUp() {
        assertThat(relay.publishPending()).isEqualTo(1);

        LifeIntakeWorkflow.Result r = result("orch-" + claimNumber + "-intake", LifeIntakeWorkflow.Result.class);

        assertThat(r.outcome()).isEqualTo("set_up");
        assertThat(sanctionsCalls.get()).isEqualTo(2);      // timed out once, retried by Temporal
        // The claim moved on, routed by rule LF-01 and owned by the least-loaded examiner.
        assertThat(one("SELECT status || '/' || track || '/' || route_rule FROM claims WHERE id = ?", String.class, claimId))
                .isEqualTo("gathering_evidence/fast_track_life/LF-01");
        assertThat(one("SELECT owner_id FROM claims WHERE id = ?", UUID.class, claimId)).isEqualTo(rachel);
        // Acknowledge and forms rows were closed by the run, never having fired; the other five are still open.
        assertThat(jdbc.sql("SELECT kind FROM deadlines WHERE claim_id = :c AND state = 'done' AND closed_by = 'intake' AND fired = false ORDER BY kind")
                .param("c", claimId).query(String.class).list()).containsExactly("acknowledge_by", "forms_by");
        assertThat(one("SELECT count(*) FROM deadlines WHERE claim_id = ? AND state = 'open'", Integer.class, claimId)).isEqualTo(5);
        // Letters: acknowledgement, a packet for each payee, and the agent notice (consent was given).
        assertThat(jdbc.sql("SELECT template_code FROM letters WHERE claim_id = :c AND status = 'sent' ORDER BY template_code, recipient_label")
                .param("c", claimId).query(String.class).list()).containsExactly("ACK-LIFE-01", "AGT-NOTE-01", "PKT-LIFE-02", "PKT-LIFE-02");
        // The examiner's queue and the run record.
        assertThat(one("SELECT action FROM work_items WHERE claim_id = ? AND owner_id = ?", String.class, claimId, rachel)).isEqualTo("New life claim: welcome call to Diane");
        assertThat(one("SELECT status FROM workflow_runs WHERE workflow_id = ?", String.class, "orch-" + claimNumber + "-intake")).isEqualTo("completed");
        assertThat(one("SELECT steps @> '[{\"label\": \"Screen the beneficiaries\", \"state\": \"retried\"}]'::jsonb FROM workflow_runs WHERE workflow_id = ?",
                Boolean.class, "orch-" + claimNumber + "-intake")).isTrue();
        assertThat(one("SELECT jsonb_array_length(steps) FROM workflow_runs WHERE workflow_id = ?", Integer.class, "orch-" + claimNumber + "-intake")).isEqualTo(6);
        assertThat(one("SELECT count(*) FROM outbox_events WHERE claim_id = ? AND published_at IS NOT NULL", Integer.class, claimId)).isEqualTo(1);
    }

    @Test
    @Order(3)
    void aRepeatedOutboxPublishStartsNothingNew() {
        // Simulate the relay crashing after starting the workflow but before stamping published_at.
        jdbc.sql("UPDATE outbox_events SET published_at = NULL WHERE claim_id = :c").param("c", claimId).update();
        int lettersBefore = one("SELECT count(*) FROM letters WHERE claim_id = ?", Integer.class, claimId);

        assertThat(relay.publishPending()).isEqualTo(1);    // published again: the start reported ALREADY_STARTED

        assertThat(one("SELECT count(*) FROM workflow_runs WHERE claim_id = ?", Integer.class, claimId)).isEqualTo(1);
        assertThat(one("SELECT count(*) FROM letters WHERE claim_id = ?", Integer.class, claimId)).isEqualTo(lettersBefore);
        assertThat(one("SELECT count(*) FROM outbox_events WHERE claim_id = ? AND published_at IS NOT NULL", Integer.class, claimId)).isEqualTo(1);
    }

    @Test
    @Order(4)
    void aDueFollowUpFiresRemindsAndWritesTheNextRow() {
        UUID mark = requirementId("Mark");
        UUID row = followUpFor(mark);
        makeDue(row);

        DeadlineDispatcher.Result d = dispatcher.dispatchDue();
        assertThat(d.started()).isEqualTo(1);
        var r = result("deadline-" + row, RequirementFollowUpActivities.Result.class);

        assertThat(r.outcome()).isEqualTo("reminded");
        // This row is done and fired; the dispatcher's attempt is on record.
        assertThat(one("SELECT state || ':' || fired || ':' || closed_by || ':' || attempt || ':' || last_outcome FROM deadlines WHERE id = ?", String.class, row))
                .isEqualTo("done:true:workflow:1:completed");
        assertThat(one("SELECT count(*) FROM deadline_attempts WHERE deadline_id = ? AND outcome = 'started'", Integer.class, row)).isEqualTo(1);
        // Exactly one new live row for Mark, ten days out at 08:00 Central.
        UUID next = followUpFor(mark);
        assertThat(next).isNotEqualTo(row).isEqualTo(r.nextDeadlineId());
        assertThat(one("SELECT due_at FROM deadlines WHERE id = ?", java.time.OffsetDateTime.class, next).toInstant())
                .isBetween(Instant.now().plus(9, ChronoUnit.DAYS), Instant.now().plus(11, ChronoUnit.DAYS));
        assertThat(one("SELECT (due_at AT TIME ZONE 'America/Chicago')::time::text FROM deadlines WHERE id = ?", String.class, next)).isEqualTo("08:00:00");
        assertThat(one("SELECT follow_up_count FROM requirements WHERE id = ?", Integer.class, mark)).isEqualTo(1);
        assertThat(jdbc.sql("SELECT template_code || ':' || channel || ':' || status FROM letters WHERE claim_id = :c AND source_id = :d")
                .param("c", claimId).param("d", row).query(String.class).single()).isEqualTo("REM-LIFE-01:email:sent");
        assertThat(one("SELECT status FROM workflow_runs WHERE workflow_id = ?", String.class, "deadline-" + row)).isEqualTo("completed");
        assertThat(one("SELECT count(*) FROM history_events WHERE claim_id = ? AND workflow_id = ? AND title LIKE 'Reminder sent%'", Integer.class, claimId, "deadline-" + row)).isEqualTo(1);
        // Nothing else is due: another poll starts nothing.
        assertThat(dispatcher.dispatchDue().claimed()).isZero();
    }

    @Test
    @Order(5)
    void aRequirementMetWhileItsRowWasWaitingIsSkippedNotReminded() {
        UUID diane = requirementId("Diane");
        UUID row = followUpFor(diane);
        // A requirement that was met by some path that did not close the row (the race the workflow re-check guards).
        jdbc.sql("UPDATE requirements SET state = 'accepted', accepted_at = now(), received_at = now() WHERE id = :id").param("id", diane).update();
        makeDue(row);
        int lettersBefore = one("SELECT count(*) FROM letters WHERE claim_id = ?", Integer.class, claimId);

        dispatcher.dispatchDue();
        var r = result("deadline-" + row, RequirementFollowUpActivities.Result.class);

        assertThat(r.outcome()).isEqualTo("skipped");
        assertThat(one("SELECT state || ':' || fired || ':' || result FROM deadlines WHERE id = ?", String.class, row)).startsWith("skipped:false:Skipped: Requirement is already accepted");
        assertThat(one("SELECT count(*) FROM letters WHERE claim_id = ?", Integer.class, claimId)).isEqualTo(lettersBefore);   // no reminder
        assertThat(one("SELECT count(*) FROM deadlines WHERE requirement_id = ? AND state IN ('open', 'dispatched')", Integer.class, diane)).isZero();   // no next row
        assertThat(one("SELECT status FROM workflow_runs WHERE workflow_id = ?", String.class, "deadline-" + row)).isEqualTo("skipped");
    }

    @Test
    @Order(6)
    void acceptingTheRemainingRequirementsLeavesNothingScheduledAndCompletesProofOfLoss() {
        UUID mark = requirementId("Mark");
        UUID cert = requirementId("death certificate");
        for (UUID r : List.of(mark, cert)) {
            long version = one("SELECT version FROM requirements WHERE id = ?", Long.class, r);
            requirements.accept(r, version, "Received", Actor.user("rachel"));
        }

        // Stop when met: no follow-up row is left live on any requirement.
        assertThat(one("SELECT count(*) FROM deadlines WHERE claim_id = ? AND kind = 'requirement_follow_up' AND state IN ('open', 'dispatched')", Integer.class, claimId)).isZero();
        // Proof of loss complete: the decision clock and review target exist, the claim is in review, the examiner has work.
        assertThat(one("SELECT status FROM claims WHERE id = ?", String.class, claimId)).isEqualTo("in_review");
        assertThat(jdbc.sql("SELECT kind FROM deadlines WHERE claim_id = :c AND state = 'open' AND kind IN ('decision_due', 'review_target') ORDER BY kind")
                .param("c", claimId).query(String.class).list()).containsExactly("decision_due", "review_target");
        assertThat(one("SELECT owner_id FROM work_items WHERE claim_id = ? AND action = 'Record decision'", UUID.class, claimId)).isEqualTo(rachel);
        // And the dispatcher has nothing to do for this claim.
        assertThat(dispatcher.dispatchDue().claimed()).isZero();
    }
}
