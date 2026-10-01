package com.example.claims.db;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.claims.deadline.DeadlineDispatcher;
import com.example.claims.intake.LifeIntakeService;
import com.example.claims.common.Actor;
import com.example.claims.support.PostgresTestSupport;
import com.example.claims.support.RecordingLauncher;
import com.example.claims.support.RequiresPostgres;
import com.example.claims.support.TestData;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
 * REQUIRES POSTGRES (TEST_PG_URL, or Docker for Testcontainers). The FOR UPDATE SKIP LOCKED behaviour cannot be
 * faked: this runs the real dispatcher SQL against a real server, with Temporal replaced by a recording launcher.
 */
@RequiresPostgres
@SpringBootTest(properties = "claims.dispatcher.batch-size=5")
@ActiveProfiles("test")
class DeadlineDispatcherPostgresTest {

    @TestConfiguration
    static class Config {
        @Bean
        @Primary
        RecordingLauncher recordingLauncher() {
            return new RecordingLauncher();
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        PostgresTestSupport.register(registry, "dispatcher");
    }

    @Autowired DeadlineDispatcher dispatcher;
    @Autowired LifeIntakeService intake;
    @Autowired RecordingLauncher launcher;
    @Autowired JdbcClient jdbc;
    @Autowired DataSource dataSource;

    @BeforeEach
    void clean() {
        launcher.reset();
        // deadline_attempts is append-only (by trigger), so earlier tests' rows stay; close what they left live instead.
        jdbc.sql("""
                UPDATE deadlines SET state = 'skipped', closed_at = now(), closed_by = 'user', result = 'test cleanup'
                WHERE state IN ('open', 'dispatched')""").update();
    }

    /** One life intake writes 3 requirement follow-ups (plus 4 other rows the dispatcher has no workflow for). */
    private List<UUID> newFollowUps(int claims) {
        for (int i = 0; i < claims; i++) {
            intake.submit(TestData.castellano("natural", "WL-" + UUID.randomUUID().toString().substring(0, 8), "Person " + i, true),
                    "key-" + UUID.randomUUID(), Actor.user("test"));
        }
        return jdbc.sql("SELECT id FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'open' ORDER BY id").query(UUID.class).list();
    }

    private void makeDue(Iterable<UUID> ids, Instant due) {
        for (UUID id : ids) {
            jdbc.sql("UPDATE deadlines SET due_at = :d, original_due_at = :d WHERE id = :id")
                    .param("d", java.time.OffsetDateTime.ofInstant(due, java.time.ZoneOffset.UTC)).param("id", id).update();
        }
    }

    private String state(UUID id) {
        return jdbc.sql("SELECT state FROM deadlines WHERE id = :id").param("id", id).query(String.class).single();
    }

    @Test
    void firesOnlyDueRowsOfKindsThatHaveAWorkflowAndMarksThemDispatched() {
        List<UUID> followUps = newFollowUps(1);
        assertThat(followUps).hasSize(3);
        makeDue(followUps.subList(0, 2), Instant.now().minus(1, ChronoUnit.MINUTES));   // third is due in 10 days
        // A due row of a kind without a workflow in this slice must be left alone, not lost.
        jdbc.sql("UPDATE deadlines SET due_at = now() - interval '1 hour', original_due_at = now() - interval '1 hour' WHERE kind = 'first_contact_by' AND state = 'open'").update();

        DeadlineDispatcher.Result r = dispatcher.dispatchDue();

        assertThat(r.claimed()).isEqualTo(2);
        assertThat(r.started()).isEqualTo(2);
        assertThat(launcher.startedDeadlines).containsExactlyInAnyOrderElementsOf(followUps.subList(0, 2));
        assertThat(state(followUps.get(0))).isEqualTo("dispatched");
        assertThat(state(followUps.get(2))).isEqualTo("open");
        assertThat(jdbc.sql("SELECT state FROM deadlines WHERE kind = 'first_contact_by' AND due_at < now() AND closed_at IS NULL").query(String.class).single()).isEqualTo("open");
        // Attempt and outcome are recorded on the row and in the append-only attempts log.
        assertThat(jdbc.sql("SELECT attempt || ':' || last_outcome || ':' || workflow_id FROM deadlines WHERE id = :id").param("id", followUps.get(0)).query(String.class).single())
                .isEqualTo("1:started:deadline-" + followUps.get(0));
        assertThat(jdbc.sql("SELECT count(*) FROM deadline_attempts WHERE outcome = 'started' AND deadline_id IN (:ids)").param("ids", followUps.subList(0, 2)).query(Integer.class).single()).isEqualTo(2);
        // Polling again finds nothing: a dispatched row is never dispatched twice.
        assertThat(dispatcher.dispatchDue().claimed()).isZero();
        assertThat(launcher.startedDeadlines).hasSize(2);
    }

    @Test
    void rowsLockedByAnotherTransactionAreSkippedNotWaitedOnAndPickedUpLater() throws Exception {
        List<UUID> rows = newFollowUps(2);   // 6 follow-ups
        makeDue(rows, Instant.now().minus(1, ChronoUnit.MINUTES));
        Set<UUID> held = new HashSet<>();

        try (Connection other = dataSource.getConnection()) {
            other.setAutoCommit(false);
            try (Statement s = other.createStatement();
                 ResultSet rs = s.executeQuery("SELECT id FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'open' ORDER BY due_at, id LIMIT 2 FOR UPDATE")) {
                while (rs.next()) held.add(rs.getObject(1, UUID.class));
            }
            assertThat(held).hasSize(2);

            long t0 = System.nanoTime();
            DeadlineDispatcher.Result r = dispatcher.dispatchDue();      // must not block on the two held rows
            long ms = (System.nanoTime() - t0) / 1_000_000;

            assertThat(r.claimed()).isEqualTo(4);
            assertThat(launcher.startedDeadlines).doesNotContainAnyElementsOf(held).hasSize(4);
            assertThat(ms).as("SKIP LOCKED must not wait for the other transaction").isLessThan(5_000);
            other.rollback();
        }

        DeadlineDispatcher.Result later = dispatcher.dispatchDue();
        assertThat(later.claimed()).isEqualTo(2);
        assertThat(launcher.startedDeadlines).containsExactlyInAnyOrderElementsOf(rows);
    }

    @Test
    void twoDispatchersRunningTogetherStartEveryDeadlineExactlyOnce() throws Exception {
        List<UUID> rows = newFollowUps(10);   // 30 rows, batch size 5
        makeDue(rows, Instant.now().minus(1, ChronoUnit.MINUTES));
        launcher.startDelayMillis = 10;       // widen the window in which they overlap

        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<Integer>> results = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            results.add(pool.submit(() -> {
                int claimed = 0;
                for (int n; (n = dispatcher.dispatchDue().claimed()) > 0; ) claimed += n;
                return claimed;
            }));
        }
        int total = 0;
        for (Future<Integer> f : results) total += f.get();
        pool.shutdown();

        assertThat(total).isEqualTo(30);
        assertThat(launcher.startedDeadlines).hasSize(30).doesNotHaveDuplicates();
        assertThat(jdbc.sql("SELECT count(*) FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'dispatched' AND attempt = 1")
                .query(Integer.class).single()).isEqualTo(30);
    }

    @Test
    void aFailedStartStaysOpenWithBackoffAndIsRetriedLater() {
        List<UUID> rows = newFollowUps(1);
        makeDue(rows, Instant.now().minus(1, ChronoUnit.MINUTES));
        UUID bad = rows.get(0);
        launcher.failFor.add(bad);

        DeadlineDispatcher.Result first = dispatcher.dispatchDue();

        assertThat(first.failed()).isEqualTo(1);
        assertThat(first.started()).isEqualTo(2);      // the others still went out
        assertThat(state(bad)).isEqualTo("open");
        assertThat(jdbc.sql("SELECT attempt || ':' || last_outcome || ':' || (retry_after > now()) FROM deadlines WHERE id = :id").param("id", bad).query(String.class).single())
                .isEqualTo("1:start_failed:true");
        assertThat(jdbc.sql("SELECT last_error FROM deadlines WHERE id = :id").param("id", bad).query(String.class).single()).contains("Temporal unavailable");
        assertThat(dispatcher.dispatchDue().claimed()).as("backing off: not polled again yet").isZero();

        // Temporal comes back and the backoff passes.
        launcher.failFor.clear();
        jdbc.sql("UPDATE deadlines SET retry_after = now() - interval '1 second' WHERE id = :id").param("id", bad).update();
        DeadlineDispatcher.Result second = dispatcher.dispatchDue();

        assertThat(second.started()).isEqualTo(1);
        assertThat(state(bad)).isEqualTo("dispatched");
        assertThat(jdbc.sql("SELECT attempt FROM deadlines WHERE id = :id").param("id", bad).query(Integer.class).single()).isEqualTo(2);
        assertThat(jdbc.sql("SELECT string_agg(outcome, ',' ORDER BY attempt) FROM deadline_attempts WHERE deadline_id = :id").param("id", bad).query(String.class).single())
                .isEqualTo("start_failed,started");
    }

    @Test
    void aWorkflowThatWasAlreadyStartedCountsAsDispatchedSoRepeatsAreHarmless() {
        List<UUID> rows = newFollowUps(1);
        makeDue(rows.subList(0, 1), Instant.now().minus(1, ChronoUnit.MINUTES));
        launcher.alreadyStarted.add(rows.get(0));      // e.g. the dispatcher crashed after starting it, before committing

        DeadlineDispatcher.Result r = dispatcher.dispatchDue();

        assertThat(r.alreadyStarted()).isEqualTo(1);
        assertThat(r.started()).isZero();
        assertThat(state(rows.get(0))).isEqualTo("dispatched");
        assertThat(jdbc.sql("SELECT last_outcome FROM deadlines WHERE id = :id").param("id", rows.get(0)).query(String.class).single()).isEqualTo("already_started");
    }

    @Test
    void thePollUsesThePartialIndexOnOpenRows() throws Exception {
        newFollowUps(1);
        try (Connection c = dataSource.getConnection(); Statement st = c.createStatement()) {
            st.execute("SET enable_seqscan = off");   // tiny table: make the planner show which index it would use
            StringBuilder plan = new StringBuilder();
            try (ResultSet rs = st.executeQuery("EXPLAIN SELECT id FROM deadlines WHERE state = 'open' AND due_at <= now() ORDER BY due_at, id LIMIT 25")) {
                while (rs.next()) plan.append(rs.getString(1)).append('\n');
            }
            st.execute("RESET enable_seqscan");
            assertThat(plan.toString()).contains("deadlines_dispatch_idx");
        }
    }
}
