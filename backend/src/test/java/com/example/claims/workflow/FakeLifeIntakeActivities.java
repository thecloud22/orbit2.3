package com.example.claims.workflow;

import com.example.claims.domain.RunStep;
import com.example.claims.temporal.LifeIntakeActivities;
import io.temporal.activity.Activity;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/** In-memory activities with scripted behaviour, so workflow logic is tested without a database. */
class FakeLifeIntakeActivities implements LifeIntakeActivities {
    final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    volatile String status = "received";
    volatile boolean policyInForce = true;
    volatile List<String> duplicates = List.of();
    volatile boolean sanctionsClear = true;
    volatile boolean consent = true;
    final AtomicInteger sanctionsFailuresLeft = new AtomicInteger(0);
    volatile boolean lettersAlwaysFail = false;

    volatile List<RunStep> completedSteps;
    volatile List<String> heldReasons;
    volatile String failedWith;
    volatile List<RunStep> stepsAtFailure;

    @Override
    public Facts begin(Input input) {
        calls.add("begin");
        return new Facts(input.claimId(), "L-26-043310", status, "Robert Castellano", "Diane Castellano", true,
                List.of(new Payee(UUID.randomUUID(), "Diane Castellano", "portal", "diane@example.com"),
                        new Payee(UUID.randomUUID(), "Mark Castellano", "portal", "mark@example.com")),
                List.of("WL-0804419"), "2026-09-19", consent, consent ? "Tom Bright" : null);
    }

    @Override
    public List<PolicyFinding> checkPolicies(UUID claimId) {
        calls.add("checkPolicies");
        return List.of(new PolicyFinding("WL-0804419", policyInForce, policyInForce ? "premium paid to 2026-09-01" : "policy lapsed"));
    }

    @Override
    public ScreenOutcome screenParties(UUID claimId) {
        calls.add("screenParties");
        if (sanctionsFailuresLeft.getAndDecrement() > 0) throw new IllegalStateException("sanctions service timed out");
        return new ScreenOutcome(sanctionsClear, Activity.getExecutionContext().getInfo().getAttempt(), "ref-1");
    }

    @Override
    public List<String> findDuplicateClaims(UUID claimId) {
        calls.add("findDuplicateClaims");
        return duplicates;
    }

    @Override
    public RouteDecision route(UUID claimId) {
        calls.add("route");
        return new RouteDecision("fast_track_life", "LF-01", List.of("Natural causes"), UUID.randomUUID(), "Rachel Kim");
    }

    @Override
    public int sendAcknowledgementAndPackets(UUID claimId) {
        calls.add("sendAcknowledgementAndPackets");
        if (lettersAlwaysFail) throw new IllegalStateException("notification provider is down");
        return 3;
    }

    @Override
    public boolean tellAgent(UUID claimId) {
        calls.add("tellAgent");
        return consent;
    }

    @Override
    public void completeSetup(UUID claimId, RouteDecision route, List<RunStep> steps) {
        calls.add("completeSetup");
        completedSteps = steps;
    }

    @Override
    public void holdForReview(UUID claimId, List<String> reasons, List<RunStep> steps) {
        calls.add("holdForReview");
        heldReasons = reasons;
    }

    @Override
    public void recordFailure(UUID claimId, String error, List<RunStep> steps) {
        calls.add("recordFailure");
        failedWith = error;
        stepsAtFailure = steps;
    }
}
