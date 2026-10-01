package com.example.claims.web;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.deadline.DeadlineService;
import com.example.claims.store.ClaimQueries;
import com.example.claims.view.Views.DeadlineView;
import com.example.claims.view.Views.Page;
import java.time.Instant;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DeadlinesController {
    public record ExtendBody(Instant newDueAt, String reason) {}

    private final DeadlineService service;
    private final ClaimQueries queries;

    public DeadlinesController(DeadlineService service, ClaimQueries queries) {
        this.service = service;
        this.queries = queries;
    }

    /** The operations view across claims: what is open, overdue, or dispatched and stuck. */
    @GetMapping("/deadlines")
    Page<DeadlineView> list(@RequestParam(required = false) String state, @RequestParam(required = false) String kind,
                            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant dueBefore,
                            @RequestParam(defaultValue = "100") int limit) {
        return Page.of(queries.deadlines(state, kind, dueBefore, Math.max(1, Math.min(limit, 500))));
    }

    @GetMapping("/deadlines/{deadlineId}")
    ResponseEntity<DeadlineView> get(@PathVariable UUID deadlineId) {
        DeadlineView d = queries.deadline(deadlineId).orElseThrow(() -> ApiException.notFound("Deadline", deadlineId));
        return ResponseEntity.ok().eTag(IfMatch.etag(d.version())).body(d);
    }

    @PostMapping("/deadlines/{deadlineId}:extend")
    ResponseEntity<DeadlineView> extend(@PathVariable UUID deadlineId, @RequestHeader("If-Match") String ifMatch,
                                        @RequestHeader(value = "X-Actor", defaultValue = "examiner.dev") String actor,
                                        @RequestBody ExtendBody body) {
        if (body.newDueAt() == null) throw ApiException.unprocessable("validation_failed", "newDueAt is required");
        DeadlineView d = service.extend(deadlineId, IfMatch.parse(ifMatch), body.newDueAt(), body.reason(), Actor.user(actor));
        return ResponseEntity.ok().eTag(IfMatch.etag(d.version())).body(d);
    }
}
