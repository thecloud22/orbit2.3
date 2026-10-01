package com.example.claims.requirement;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.common.BusinessCalendar;
import com.example.claims.common.Db;
import com.example.claims.domain.DeadlineKind;
import com.example.claims.domain.RequirementState;
import com.example.claims.store.ClaimQueries;
import com.example.claims.store.DeadlineRepository;
import com.example.claims.store.DeadlineRepository.NewDeadline;
import com.example.claims.store.HistoryRepository;
import com.example.claims.store.RequirementRepository;
import com.example.claims.store.WorkItemRepository;
import com.example.claims.view.Views.RequirementView;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Accepting or waiving a requirement: Postgres only, so no workflow. One transaction saves the new state, closes the
 * follow-up rows still waiting, writes the history, and, when it was the last requirement, completes proof of loss
 * (status in_review, the decision clock and review target as deadline rows, a work item for the owner).
 * Documents arriving and being classified (the event workflow that would normally call accept) is not built.
 */
@Service
public class RequirementService {
    public static final int DECISION_DAYS = 30;
    public static final int REVIEW_BUSINESS_DAYS = 5;

    private final RequirementRepository requirements;
    private final DeadlineRepository deadlines;
    private final HistoryRepository history;
    private final WorkItemRepository workItems;
    private final ClaimQueries queries;
    private final JdbcClient jdbc;
    private final BusinessCalendar calendar;
    private final Clock clock;

    public RequirementService(RequirementRepository requirements, DeadlineRepository deadlines, HistoryRepository history,
                              WorkItemRepository workItems, ClaimQueries queries, JdbcClient jdbc, BusinessCalendar calendar, Clock clock) {
        this.requirements = requirements;
        this.deadlines = deadlines;
        this.history = history;
        this.workItems = workItems;
        this.queries = queries;
        this.jdbc = jdbc;
        this.calendar = calendar;
        this.clock = clock;
    }

    @Transactional
    public RequirementView accept(UUID id, long ifMatch, String satisfiedBy, Actor actor) {
        RequirementRepository.Row r = lockAndCheck(id, ifMatch);
        Instant now = clock.instant();
        requirements.markAccepted(id, satisfiedBy == null || satisfiedBy.isBlank() ? "Accepted by " + actor.name() : satisfiedBy, now);
        int closed = deadlines.closeOpenFollowUps(id, "Closed: requirement accepted", now);
        history.append(r.claimId(), now, "data", "Requirement met: " + r.name(), actor,
                closed > 0 ? closed + " follow-up row" + (closed > 1 ? "s" : "") + " closed" : null, r.name(), null);
        afterMet(r.claimId(), now);
        return queries.requirement(id).orElseThrow();
    }

    @Transactional
    public RequirementView waive(UUID id, long ifMatch, String reason, Actor actor) {
        if (reason == null || reason.isBlank()) throw ApiException.unprocessable("reason_required", "Waiving a requirement needs a reason");
        RequirementRepository.Row r = lockAndCheck(id, ifMatch);
        Instant now = clock.instant();
        requirements.markWaived(id, reason.trim(), actor.name(), now);
        deadlines.closeOpenFollowUps(id, "Closed: requirement waived", now);
        history.append(r.claimId(), now, "data", "Requirement waived: " + r.name(), actor, reason.trim(), r.name(), null);
        afterMet(r.claimId(), now);
        return queries.requirement(id).orElseThrow();
    }

    private RequirementRepository.Row lockAndCheck(UUID id, long ifMatch) {
        RequirementRepository.Row r = requirements.lock(id).orElseThrow(() -> ApiException.notFound("Requirement", id));
        if (r.version() != ifMatch) throw ApiException.versionConflict("Requirement " + id);
        if (r.state() == RequirementState.ACCEPTED || r.state() == RequirementState.WAIVED || r.state() == RequirementState.EXPIRED) {
            throw ApiException.conflict("invalid_state", "Requirement is already " + r.state().db());
        }
        return r;
    }

    /** Proof of loss is complete when every requirement is accepted or waived: the decision clock starts. */
    private void afterMet(UUID claimId, Instant now) {
        if (requirements.countUnmet(claimId) > 0) return;
        int moved = jdbc.sql("UPDATE claims SET status = 'in_review', proof_complete_at = :now WHERE id = :id AND status = 'gathering_evidence'")
                .param("now", Db.ts(now)).param("id", claimId).update();
        if (moved == 0) return;   // received (set-up not finished yet) or already past evidence
        Instant decisionDue = calendar.daysAfter(now, DECISION_DAYS);
        Instant reviewDue = calendar.businessDaysAfter(now, REVIEW_BUSINESS_DAYS);
        UUID decisionRow = deadlines.insert(new NewDeadline(claimId, DeadlineKind.DECISION_DUE, null, "Decide the claim", "decide", decisionDue));
        UUID reviewRow = deadlines.insert(new NewDeadline(claimId, DeadlineKind.REVIEW_TARGET, null, "Examiner review done (alerts the team lead if not)", "review", reviewDue));
        jdbc.sql("UPDATE benefit_lines SET status = 'ready_to_decide', waiting_on = 'Decision' WHERE claim_id = :id AND status = 'gathering_evidence'")
                .param("id", claimId).update();
        // owner_id may be null (unassigned claim): the work item then goes to the team queue.
        UUID owner = jdbc.sql("SELECT owner_id FROM claims WHERE id = :id").param("id", claimId).query((rs, i) -> Db.uuid(rs, 1)).list().get(0);
        workItems.insertOnce("record-decision:" + claimId, owner, claimId, 1, "Record decision",
                "Proof of loss complete · state limit " + calendar.localDate(decisionDue), calendar.localDate(reviewDue), "You", "decision", "workflow", null);
        history.append(claimId, now, "data", "Proof of loss complete: decision clock started", Actor.system("rules"),
                "Decide by " + calendar.localDate(decisionDue) + " (" + decisionRow + ") · review by " + calendar.localDate(reviewDue) + " (" + reviewRow + ")", null, null);
    }
}
