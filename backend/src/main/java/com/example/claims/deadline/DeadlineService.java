package com.example.claims.deadline;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.store.ClaimQueries;
import com.example.claims.store.DeadlineRepository;
import com.example.claims.store.HistoryRepository;
import com.example.claims.view.Views.DeadlineView;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DeadlineService {
    private final DeadlineRepository deadlines;
    private final HistoryRepository history;
    private final ClaimQueries queries;
    private final Clock clock;

    public DeadlineService(DeadlineRepository deadlines, HistoryRepository history, ClaimQueries queries, Clock clock) {
        this.deadlines = deadlines;
        this.history = history;
        this.queries = queries;
        this.clock = clock;
    }

    /** An extension is a row update with a reason: due_at moves, original_due_at stays, the history says why. */
    @Transactional
    public DeadlineView extend(UUID id, long ifMatch, Instant newDueAt, String reason, Actor actor) {
        if (reason == null || reason.isBlank()) throw ApiException.unprocessable("reason_required", "An extension needs a reason");
        DeadlineRepository.Row d = deadlines.lock(id).orElseThrow(() -> ApiException.notFound("Deadline", id));
        if (d.version() != ifMatch) throw ApiException.versionConflict("Deadline " + id);
        if (d.state() != com.example.claims.domain.DeadlineState.OPEN) {
            throw ApiException.conflict("deadline_not_open", "Only an open deadline can be extended; this one is " + d.state().db());
        }
        if (!newDueAt.isAfter(d.dueAt())) throw ApiException.unprocessable("not_an_extension", "The new due date must be later than the current one");
        deadlines.extend(id, ifMatch, newDueAt, reason.trim());
        history.append(d.claimId(), clock.instant(), "data", "Deadline extended: " + d.what(), actor,
                "From " + d.dueAt() + " to " + newDueAt + ": " + reason.trim(), null, null);
        return queries.deadline(id).orElseThrow();
    }
}
