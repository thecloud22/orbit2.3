package com.example.claims.web;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.intake.LifeIntakeRequest;
import com.example.claims.intake.LifeIntakeService;
import com.example.claims.store.ClaimQueries;
import com.example.claims.view.Views.*;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ClaimsController {
    private final LifeIntakeService intake;
    private final ClaimQueries queries;

    public ClaimsController(LifeIntakeService intake, ClaimQueries queries) {
        this.intake = intake;
        this.queries = queries;
    }

    /**
     * Commits the claim, requirements and first deadline rows in one transaction and returns; the intake workflow runs
     * afterwards. 201 with the claim (status received); 200 with the same claim when the Idempotency-Key repeats.
     */
    @PostMapping("/claims/life-intake")
    ResponseEntity<ClaimView> lifeIntake(@RequestHeader("Idempotency-Key") String key,
                                         @RequestHeader(value = "X-Actor", defaultValue = "intake.dev") String actor,
                                         @Valid @RequestBody LifeIntakeRequest request) {
        if (key.length() < 8 || key.length() > 128) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");
        }
        LifeIntakeService.Result result = intake.submit(request, key, Actor.user(actor));
        ClaimView claim = result.claim();
        ResponseEntity.BodyBuilder response = result.replayed() ? ResponseEntity.ok() : ResponseEntity.created(URI.create("/claims/" + claim.id()));
        if (result.replayed()) response.header("Idempotent-Replayed", "true");
        return response.eTag(IfMatch.etag(claim.version())).body(claim);
    }

    @GetMapping("/claims/{claimId}")
    ResponseEntity<ClaimView> claim(@PathVariable UUID claimId) {
        ClaimView c = queries.claim(claimId).orElseThrow(() -> ApiException.notFound("Claim", claimId));
        return ResponseEntity.ok().eTag(IfMatch.etag(c.version())).body(c);
    }

    @GetMapping("/claims")
    Page<ClaimSummary> claims(@RequestParam(required = false) UUID owner, @RequestParam(required = false) String status,
                              @RequestParam(required = false) String family, @RequestParam(required = false) String claimNumber,
                              @RequestParam(defaultValue = "25") int limit, @RequestParam(required = false) String cursor) {
        return queries.claims(owner, status, family, claimNumber, Math.max(1, Math.min(limit, 100)), cursor);
    }
}
