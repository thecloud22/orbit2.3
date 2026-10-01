package com.example.claims.temporal;

import com.example.claims.domain.RunStep;
import io.temporal.activity.ActivityInterface;
import java.util.List;
import java.util.UUID;

/**
 * What the life intake orchestration does. Each method is one step: it calls one system, or does one
 * Postgres transaction, and is safe to repeat (Temporal retries activities).
 */
/** Activity type names are prefixed (LifeIntake_...) because several interfaces share one worker and method names such as begin and recordFailure repeat. */
@ActivityInterface(namePrefix = "LifeIntake_")
public interface LifeIntakeActivities {

    record Input(UUID claimId, UUID eventId) {}

    record Payee(UUID partyId, String name, String packet, String email) {}

    record Facts(UUID claimId, String claimNumber, String status, String insuredName, String callerName, boolean callerByEmail,
                 List<Payee> payees, List<String> policyNumbers, String dateOfDeath, boolean agentConsent, String agentName) {
        public boolean alreadySetUp() { return !status.equals("received"); }
    }

    record PolicyFinding(String policyNumber, boolean inForce, String note) {}

    record ScreenOutcome(boolean clear, int attempts, String reference) {}

    record RouteDecision(String track, String rule, List<String> reasons, UUID examinerId, String examinerName) {}

    /** Starts the run record for this workflow run and loads the claim as the workflow sees it. */
    Facts begin(Input input);

    List<PolicyFinding> checkPolicies(UUID claimId);

    ScreenOutcome screenParties(UUID claimId);

    /** Claim numbers of other open claims for the same death. */
    List<String> findDuplicateClaims(UUID claimId);

    RouteDecision route(UUID claimId);

    /** The acknowledgement to the caller and a claim packet to each payee. Returns letters sent. */
    int sendAcknowledgementAndPackets(UUID claimId);

    /** Status-only notice to the agent of record, when the caller consented. Returns false when skipped. */
    boolean tellAgent(UUID claimId);

    /** One transaction: status, route, owner, closes the ack/forms rows, welcome-call work item, history, run record. */
    void completeSetup(UUID claimId, RouteDecision route, List<RunStep> steps);

    /** Something doubtful: leave the claim as received and open a task for a person. */
    void holdForReview(UUID claimId, List<String> reasons, List<RunStep> steps);

    /** The workflow gave up after retries: mark the run failed and open an ops task. */
    void recordFailure(UUID claimId, String error, List<RunStep> steps);
}
