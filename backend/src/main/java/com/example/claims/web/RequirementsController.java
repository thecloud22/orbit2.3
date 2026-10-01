package com.example.claims.web;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.requirement.RequirementService;
import com.example.claims.store.ClaimQueries;
import com.example.claims.view.Views.RequirementView;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RequirementsController {
    public record AcceptBody(String satisfiedBy) {}

    public record WaiveBody(String reason) {}

    private final RequirementService service;
    private final ClaimQueries queries;

    public RequirementsController(RequirementService service, ClaimQueries queries) {
        this.service = service;
        this.queries = queries;
    }

    @GetMapping("/requirements/{requirementId}")
    ResponseEntity<RequirementView> get(@PathVariable UUID requirementId) {
        RequirementView r = queries.requirement(requirementId).orElseThrow(() -> ApiException.notFound("Requirement", requirementId));
        return ResponseEntity.ok().eTag(IfMatch.etag(r.version())).body(r);
    }

    @PostMapping("/requirements/{requirementId}:accept")
    ResponseEntity<RequirementView> accept(@PathVariable UUID requirementId, @RequestHeader("If-Match") String ifMatch,
                                           @RequestHeader(value = "X-Actor", defaultValue = "examiner.dev") String actor,
                                           @RequestBody(required = false) AcceptBody body) {
        RequirementView r = service.accept(requirementId, IfMatch.parse(ifMatch), body == null ? null : body.satisfiedBy(), Actor.user(actor));
        return ResponseEntity.ok().eTag(IfMatch.etag(r.version())).body(r);
    }

    @PostMapping("/requirements/{requirementId}:waive")
    ResponseEntity<RequirementView> waive(@PathVariable UUID requirementId, @RequestHeader("If-Match") String ifMatch,
                                          @RequestHeader(value = "X-Actor", defaultValue = "examiner.dev") String actor,
                                          @RequestBody WaiveBody body) {
        RequirementView r = service.waive(requirementId, IfMatch.parse(ifMatch), body.reason(), Actor.user(actor));
        return ResponseEntity.ok().eTag(IfMatch.etag(r.version())).body(r);
    }
}
