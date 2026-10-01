package com.example.claims.deadline;

import com.example.claims.common.Actor;
import com.example.claims.common.BusinessCalendar;
import com.example.claims.domain.ClaimStatus;
import com.example.claims.domain.DeadlineKind;
import com.example.claims.domain.DeadlineState;
import com.example.claims.domain.RequirementState;
import com.example.claims.domain.RunStep;
import com.example.claims.intake.LifeIntakeRules;
import com.example.claims.store.DeadlineRepository;
import com.example.claims.store.DeadlineRepository.NewDeadline;
import com.example.claims.store.HistoryRepository;
import com.example.claims.store.LetterRepository.NewLetter;
import com.example.claims.store.LetterService;
import com.example.claims.store.RequirementRepository;
import com.example.claims.store.WorkItemRepository;
import com.example.claims.store.WorkflowRunRepository;
import com.example.claims.temporal.RequirementFollowUpActivities.Check;
import com.example.claims.temporal.RequirementFollowUpActivities.Result;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The database work of the requirement follow-up deadline workflow. Every method is safe to repeat: the
 * compare-and-set close in DeadlineRepository.closeLive() decides who did the work, and the unique index on
 * live follow-ups stops a second "next row".
 *
 * Lock order (also used by RequirementService): requirement row first, then deadline rows.
 */
@Service
public class FollowUpService {
    private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("EEE d MMM HH:mm");

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final DeadlineRepository deadlines;
    private final RequirementRepository requirements;
    private final HistoryRepository history;
    private final WorkflowRunRepository runs;
    private final WorkItemRepository workItems;
    private final LetterService letters;
    private final BusinessCalendar calendar;
    private final Clock clock;

    public FollowUpService(JdbcClient jdbc, TransactionTemplate tx, DeadlineRepository deadlines, RequirementRepository requirements,
                           HistoryRepository history, WorkflowRunRepository runs, WorkItemRepository workItems, LetterService letters,
                           BusinessCalendar calendar, Clock clock) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.deadlines = deadlines;
        this.requirements = requirements;
        this.history = history;
        this.runs = runs;
        this.workItems = workItems;
        this.letters = letters;
        this.calendar = calendar;
        this.clock = clock;
    }

    private DeadlineRepository.Row deadline(UUID id) {
        return deadlines.find(id).orElseThrow(() -> new IllegalStateException("Deadline " + id + " does not exist"));
    }

    private static String channelFor(String requirementKey) {
        return requirementKey.equals("report") || requirementKey.equals("amended_certificate") ? "fax" : "email";
    }

    private ClaimStatus claimStatus(UUID claimId) {
        return ClaimStatus.of(jdbc.sql("SELECT status FROM claims WHERE id = :id").param("id", claimId).query(String.class).single());
    }

    /** Step 1: open the run record, then re-check that the deadline still applies. */
    public Check begin(UUID deadlineId, String workflowId, String runId) {
        DeadlineRepository.Row d = deadline(deadlineId);
        runs.begin(workflowId, runId, "deadline", "Requirement follow-up", d.claimId(),
                "Dispatcher · Temporal Schedule · deadline " + deadlineId + " due", "deadline", deadlineId, clock.instant());
        if (!d.state().live()) {
            return new Check(false, "Already " + d.state().db(), "", "", "");
        }
        if (d.kind() != DeadlineKind.REQUIREMENT_FOLLOW_UP || d.requirementId() == null) {
            return new Check(false, "Not a requirement follow-up", "", "", "");
        }
        RequirementRepository.Row r = requirements.find(d.requirementId()).orElseThrow();
        if (!r.state().chasing()) return new Check(false, "Requirement is already " + r.state().db(), r.name(), r.fromLabel(), channelFor(r.key()));
        if (claimStatus(d.claimId()).decidedOrClosed()) return new Check(false, "The claim is already decided", r.name(), r.fromLabel(), channelFor(r.key()));
        return new Check(true, null, r.name(), r.fromLabel(), channelFor(r.key()));
    }

    /** Step 2: the reminder, once per deadline. */
    public void sendReminder(UUID deadlineId, String workflowId) {
        DeadlineRepository.Row d = deadline(deadlineId);
        RequirementRepository.Row r = requirements.find(d.requirementId()).orElseThrow();
        int n = r.followUpCount() + 1;
        letters.sendOnce(new NewLetter(d.claimId(), "REM-LIFE-01", channelFor(r.key()), r.fromPartyId(), r.fromLabel(),
                "Reminder: " + r.name(), "Reminder " + n + ". We still need it to decide the claim.", "deadline", deadlineId, workflowId,
                "deadline:" + deadlineId + ":reminder"), r.fromLabel());
    }

    /**
     * Step 3, one transaction: this deadline done, the next follow-up row written, the reminder in the history and the
     * run saved. If the requirement was accepted while the reminder was in flight, the deadline is skipped instead and
     * no next row is written.
     */
    public Result complete(UUID deadlineId, List<RunStep> steps, String workflowId, String runId) {
        return tx.execute(s -> {
            Instant now = clock.instant();
            DeadlineRepository.Row d = deadline(deadlineId);
            RequirementRepository.Row r = requirements.lock(d.requirementId()).orElseThrow();
            DeadlineRepository.Row locked = deadlines.lock(deadlineId).orElseThrow();
            if (!locked.state().live()) {
                Optional<DeadlineRepository.Row> next = deadlines.liveFollowUp(r.id());
                return new Result("already_closed", next.map(DeadlineRepository.Row::id).orElse(null), "Already " + locked.state().db());
            }
            if (!r.state().chasing() || claimStatus(d.claimId()).decidedOrClosed()) {
                deadlines.closeLive(deadlineId, DeadlineState.SKIPPED, "workflow", "Requirement became " + r.state().db() + " while the reminder was in flight",
                        false, "skipped", runId, now);
                runs.finish(workflowId, runId, "skipped", steps, List.of("Deadline skipped: requirement " + r.state().db()), null, now);
                return new Result("skipped", null, "Requirement became " + r.state().db());
            }
            String channel = channelFor(r.key());
            String when = WHEN.format(LocalDateTime.ofInstant(now, calendar.zone()));
            deadlines.closeLive(deadlineId, DeadlineState.DONE, "workflow", "Fired " + when + " → reminder sent by " + channel, true,
                    "completed", runId, now);
            int days = r.followUpDays() > 0 ? r.followUpDays() : LifeIntakeRules.FOLLOW_UP_DAYS;
            Instant nextDue = calendar.daysAfter(now, days);
            UUID nextId = deadlines.insert(new NewDeadline(d.claimId(), DeadlineKind.REQUIREMENT_FOLLOW_UP, r.id(), "Follow up again: " + r.name(), null, nextDue));
            requirements.recordReminder(r.id(), now);
            history.append(d.claimId(), now, "communication", "Reminder sent: " + r.name(), Actor.workflow(workflowId),
                    "Deadline " + deadlineId + " came due · next follow-up " + nextId + " on " + calendar.localDate(nextDue), r.name(), workflowId);
            runs.finish(workflowId, runId, "completed", steps, List.of("Deadline " + deadlineId + " done",
                    "Next follow-up " + nextId + " due " + calendar.localDate(nextDue), "Reminder in the history"), null, now);
            return new Result("reminded", nextId, "Next follow-up due " + calendar.localDate(nextDue));
        });
    }

    /** Skipped: the deadline no longer applies. */
    public Result skip(UUID deadlineId, String reason, List<RunStep> steps, String workflowId, String runId) {
        return tx.execute(s -> {
            Instant now = clock.instant();
            DeadlineRepository.Row d = deadline(deadlineId);
            boolean closed = deadlines.closeLive(deadlineId, DeadlineState.SKIPPED, "workflow", "Skipped: " + reason, false, "skipped", runId, now);
            if (closed) {
                history.append(d.claimId(), now, "data", "Follow-up skipped: " + reason, Actor.workflow(workflowId),
                        "Deadline " + deadlineId, null, workflowId);
            }
            runs.finish(workflowId, runId, "skipped", steps, List.of(closed ? "Deadline skipped: " + reason : "Deadline was already closed"), null, now);
            return new Result(closed ? "skipped" : "already_closed", null, reason);
        });
    }

    /** Retries exhausted. The deadline stays dispatched so the nightly check finds it too; a person gets a task. */
    public void recordFailure(UUID deadlineId, String error, List<RunStep> steps, String workflowId, String runId) {
        tx.executeWithoutResult(s -> {
            Instant now = clock.instant();
            DeadlineRepository.Row d = deadline(deadlineId);
            workItems.insertOnce("workflow-failed:" + workflowId, null, d.claimId(), 1, "Deadline workflow failed: " + d.what(),
                    "Workflow " + workflowId + " gave up: " + error, calendar.localDate(now), "You", "workflow", "deadline", deadlineId);
            history.append(d.claimId(), now, "task", "Deadline workflow failed after retries: " + d.what(), Actor.workflow(workflowId), error, null, workflowId);
            runs.finish(workflowId, runId, "failed", steps, List.of("Ops task opened", "Deadline stays dispatched"), error, now);
        });
    }
}
