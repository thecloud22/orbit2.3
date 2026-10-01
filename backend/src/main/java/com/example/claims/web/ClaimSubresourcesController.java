package com.example.claims.web;

import com.example.claims.common.ApiException;
import com.example.claims.store.ClaimQueries;
import com.example.claims.view.Views.*;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Read-only collections that hang off a claim. The claim must exist (404 otherwise, not an empty list). */
@RestController
public class ClaimSubresourcesController {
    private final ClaimQueries queries;
    private final JdbcClient jdbc;

    public ClaimSubresourcesController(ClaimQueries queries, JdbcClient jdbc) {
        this.queries = queries;
        this.jdbc = jdbc;
    }

    private void requireClaim(UUID id) {
        boolean exists = jdbc.sql("SELECT EXISTS (SELECT 1 FROM claims WHERE id = :id)").param("id", id).query(Boolean.class).single();
        if (!exists) throw ApiException.notFound("Claim", id);
    }

    @GetMapping("/claims/{claimId}/requirements")
    Page<RequirementView> requirements(@PathVariable UUID claimId) {
        requireClaim(claimId);
        return Page.of(queries.requirements(claimId));
    }

    @GetMapping("/claims/{claimId}/deadlines")
    Page<DeadlineView> deadlines(@PathVariable UUID claimId) {
        requireClaim(claimId);
        return Page.of(queries.deadlines(claimId));
    }

    @GetMapping("/claims/{claimId}/letters")
    Page<LetterView> letters(@PathVariable UUID claimId) {
        requireClaim(claimId);
        return Page.of(queries.letters(claimId));
    }

    @GetMapping("/claims/{claimId}/workflow-runs")
    Page<WorkflowRunView> workflowRuns(@PathVariable UUID claimId) {
        requireClaim(claimId);
        return Page.of(queries.workflowRuns(claimId));
    }

    @GetMapping("/claims/{claimId}/history")
    Page<HistoryEventView> history(@PathVariable UUID claimId, @RequestParam(defaultValue = "50") int limit,
                                   @RequestParam(required = false) String cursor) {
        requireClaim(claimId);
        return queries.history(claimId, Math.max(1, Math.min(limit, 200)), cursor);
    }
}
