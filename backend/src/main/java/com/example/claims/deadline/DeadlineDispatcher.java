package com.example.claims.deadline;

import com.example.claims.config.ClaimsProperties;
import com.example.claims.store.DeadlineRepository;
import com.example.claims.temporal.WorkflowLauncher;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Fires deadlines that have come due. Every minute a Temporal Schedule runs the dispatcher workflow, which calls
 * dispatchDue() until a batch comes back short. (Or, in dev, a Spring scheduler calls it: same code path.)
 *
 * One poll is ONE transaction:
 *   1. SELECT due rows FOR UPDATE SKIP LOCKED. Concurrent dispatchers skip each other's rows, so no row is fired twice.
 *   2. For each row, start workflow deadline-&lt;id&gt;. The id makes a repeat start a no-op, so a crash after a start
 *      but before the commit only costs a harmless ALREADY_STARTED next time.
 *   3. Mark the row dispatched (attempt+1, workflow id, outcome) and append a deadline_attempts line.
 *      If the start itself fails, the row stays open with a backoff (retry_after) and the error is recorded.
 *
 * The workflow's own writes to the row wait for this transaction's row lock, then see the committed state.
 * Trade-off: locks are held while the (fast, batch-limited) starts are made; the alternative, commit-then-start,
 * can strand a row as dispatched with no workflow.
 */
@Service
public class DeadlineDispatcher {
    private static final Logger log = LoggerFactory.getLogger(DeadlineDispatcher.class);

    public record Result(int claimed, int started, int alreadyStarted, int failed, boolean batchWasFull) {}

    private final DeadlineRepository deadlines;
    private final WorkflowLauncher launcher;
    private final TransactionTemplate tx;
    private final ClaimsProperties props;
    private final Clock clock;

    public DeadlineDispatcher(DeadlineRepository deadlines, WorkflowLauncher launcher, TransactionTemplate tx, ClaimsProperties props, Clock clock) {
        this.deadlines = deadlines;
        this.launcher = launcher;
        this.tx = tx;
        this.props = props;
        this.clock = clock;
    }

    public Result dispatchDue() {
        return tx.execute(status -> poll());
    }

    private Result poll() {
        Instant now = clock.instant();
        int limit = props.dispatcher().batchSize();
        List<DeadlineRepository.Row> due = deadlines.lockDue(now, launcher.supportedDeadlineKinds(), limit);
        int started = 0, already = 0, failed = 0;
        for (DeadlineRepository.Row row : due) {
            int attempt = row.attempt() + 1;
            WorkflowLauncher.Started result;
            try {
                result = launcher.startDeadlineWorkflow(row.kind(), row.id());
            } catch (RuntimeException e) {
                failed++;
                Instant retry = now.plus(backoff(attempt));
                log.warn("Could not start workflow for deadline {} (attempt {}): {}", row.id(), attempt, e.toString());
                deadlines.markStartFailed(row.id(), e.toString(), retry);
                deadlines.addAttempt(row.id(), attempt, "start_failed", null, e.toString());
                continue;
            }
            String outcome = result.outcome() == WorkflowLauncher.Outcome.STARTED ? "started" : "already_started";
            if (result.outcome() == WorkflowLauncher.Outcome.STARTED) started++; else already++;
            deadlines.markDispatched(row.id(), result.workflowId(), outcome, now);
            deadlines.addAttempt(row.id(), attempt, outcome, result.workflowId(), null);
        }
        return new Result(due.size(), started, already, failed, due.size() >= limit);
    }

    private Duration backoff(int attempt) {
        Duration d = props.dispatcher().retryBase().multipliedBy(attempt);
        return d.compareTo(props.dispatcher().retryMax()) > 0 ? props.dispatcher().retryMax() : d;
    }
}
