package com.example.claims.store;

import static com.example.claims.common.Db.instant;
import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import com.example.claims.common.Db;
import com.example.claims.domain.DeadlineKind;
import com.example.claims.domain.DeadlineState;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Every SQL statement that touches the deadlines table. */
@Repository
public class DeadlineRepository {

    public record Row(UUID id, UUID claimId, DeadlineKind kind, UUID requirementId, String what, Instant dueAt,
                      DeadlineState state, int attempt, long version) {}

    public record NewDeadline(UUID claimId, DeadlineKind kind, UUID requirementId, String what, String sla, Instant dueAt) {}

    private final JdbcClient jdbc;

    public DeadlineRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    private static final String COLS = "id, claim_id, kind, requirement_id, what, due_at, state, attempt, version";

    private static Row row(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Row(uuid(rs, "id"), uuid(rs, "claim_id"), DeadlineKind.of(rs.getString("kind")), uuid(rs, "requirement_id"),
                rs.getString("what"), instant(rs, "due_at"), DeadlineState.of(rs.getString("state")), rs.getInt("attempt"),
                rs.getLong("version"));
    }

    public UUID insert(NewDeadline d) {
        return jdbc.sql("""
                INSERT INTO deadlines (claim_id, kind, requirement_id, what, sla, due_at, original_due_at)
                VALUES (:claim, :kind, :req, :what, :sla, :due, :due) RETURNING id""")
                .param("claim", d.claimId()).param("kind", d.kind().db()).param("req", d.requirementId())
                .param("what", d.what()).param("sla", d.sla()).param("due", ts(d.dueAt()))
                .query((rs, n) -> uuid(rs, "id")).single();
    }

    public Optional<Row> find(UUID id) {
        return jdbc.sql("SELECT " + COLS + " FROM deadlines WHERE id = :id").param("id", id).query(DeadlineRepository::row).optional();
    }

    public Optional<Row> lock(UUID id) {
        return jdbc.sql("SELECT " + COLS + " FROM deadlines WHERE id = :id FOR UPDATE").param("id", id).query(DeadlineRepository::row).optional();
    }

    /**
     * The dispatcher's poll. FOR UPDATE SKIP LOCKED means two dispatchers (or a Schedule run overlapping a
     * manual one) never take the same row: each simply skips what the other holds. Uses deadlines_dispatch_idx.
     */
    public List<Row> lockDue(Instant now, Collection<DeadlineKind> kinds, int limit) {
        return jdbc.sql("SELECT " + COLS + """
                 FROM deadlines
                WHERE state = 'open' AND due_at <= :now AND (retry_after IS NULL OR retry_after <= :now)
                  AND kind = ANY (cast(:kinds as text[]))
                ORDER BY due_at, id
                LIMIT :limit
                FOR UPDATE SKIP LOCKED""")
                .param("now", ts(now)).param("kinds", Db.arrayLiteral(kinds.stream().map(DeadlineKind::db).toList()))
                .param("limit", limit)
                .query(DeadlineRepository::row).list();
    }

    public void markDispatched(UUID id, String workflowId, String outcome, Instant now) {
        jdbc.sql("""
                UPDATE deadlines SET state = 'dispatched', attempt = attempt + 1, dispatched_at = :now, workflow_id = :wf,
                       last_outcome = :outcome, last_error = NULL, retry_after = NULL
                WHERE id = :id AND state = 'open'""")
                .param("now", ts(now)).param("wf", workflowId).param("outcome", outcome).param("id", id).update();
    }

    public void markStartFailed(UUID id, String error, Instant retryAfter) {
        jdbc.sql("""
                UPDATE deadlines SET attempt = attempt + 1, last_outcome = 'start_failed', last_error = :err, retry_after = :retry
                WHERE id = :id AND state = 'open'""")
                .param("err", truncate(error)).param("retry", ts(retryAfter)).param("id", id).update();
    }

    public void addAttempt(UUID id, int attempt, String outcome, String workflowId, String error) {
        jdbc.sql("INSERT INTO deadline_attempts (deadline_id, attempt, outcome, workflow_id, error) VALUES (:id, :n, :o, :wf, :e)")
                .param("id", id).param("n", attempt).param("o", outcome).param("wf", workflowId).param("e", truncate(error)).update();
    }

    /**
     * Compare-and-set close: only a live row (open or dispatched) can be closed, so a repeated call, or
     * a workflow that lost a race with the requirement being accepted, changes nothing and returns false.
     */
    public boolean closeLive(UUID id, DeadlineState to, String closedBy, String result, boolean fired, String outcome,
                             String runId, Instant now) {
        return jdbc.sql("""
                UPDATE deadlines SET state = :to, closed_at = :now, closed_by = :by, result = :result,
                       fired = (fired OR :fired), last_outcome = :outcome, workflow_run_id = COALESCE(:run, workflow_run_id)
                WHERE id = :id AND state IN ('open', 'dispatched')""")
                .param("to", to.db()).param("now", ts(now)).param("by", closedBy).param("result", result).param("fired", fired)
                .param("outcome", outcome).param("run", runId).param("id", id).update() == 1;
    }

    /** A requirement was accepted or waived: its waiting follow-up rows close without ever firing. */
    public int closeOpenFollowUps(UUID requirementId, String result, Instant now) {
        return jdbc.sql("""
                UPDATE deadlines SET state = 'done', closed_at = :now, closed_by = 'requirement', result = :result,
                       last_outcome = 'closed_early'
                WHERE requirement_id = :req AND kind = 'requirement_follow_up' AND state = 'open'""")
                .param("now", ts(now)).param("result", result).param("req", requirementId).update();
    }

    public Optional<Row> liveFollowUp(UUID requirementId) {
        return jdbc.sql("SELECT " + COLS + " FROM deadlines WHERE requirement_id = :r AND kind = 'requirement_follow_up' AND state IN ('open','dispatched')")
                .param("r", requirementId).query(DeadlineRepository::row).optional();
    }

    /** Extending is an UPDATE with a reason. Only an open row, and only when the caller saw the current version. */
    public int extend(UUID id, long expectedVersion, Instant newDueAt, String reason) {
        return jdbc.sql("""
                UPDATE deadlines SET due_at = :due, extension_reason = :reason
                WHERE id = :id AND version = :v AND state = 'open'""")
                .param("due", ts(newDueAt)).param("reason", reason).param("id", id).param("v", expectedVersion).update();
    }

    private static String truncate(String s) {
        return s == null ? null : s.length() > 1000 ? s.substring(0, 1000) : s;
    }
}
