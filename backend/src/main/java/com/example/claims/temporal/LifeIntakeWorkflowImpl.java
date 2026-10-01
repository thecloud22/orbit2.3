package com.example.claims.temporal;

import com.example.claims.domain.RunStep;
import com.example.claims.temporal.LifeIntakeActivities.*;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class LifeIntakeWorkflowImpl implements LifeIntakeWorkflow {

    private final LifeIntakeActivities act = Workflow.newActivityStub(LifeIntakeActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(30))
                    .setRetryOptions(RetryOptions.newBuilder()
                            .setInitialInterval(Duration.ofSeconds(2)).setBackoffCoefficient(2.0)
                            .setMaximumInterval(Duration.ofSeconds(30)).setMaximumAttempts(5).build())
                    .build());

    @Override
    public Result run(Input in) {
        List<RunStep> steps = new ArrayList<>();
        try {
            Facts facts = act.begin(in);
            if (facts.alreadySetUp()) {
                return new Result("already_set_up", "Claim " + facts.claimNumber() + " is already " + facts.status());
            }
            List<String> doubts = new ArrayList<>();

            // 1. Policies: found, and in force on the date of death.
            List<PolicyFinding> policies = act.checkPolicies(in.claimId());
            long inForce = policies.stream().filter(PolicyFinding::inForce).count();
            steps.add(RunStep.done("Confirm in force on the date of death",
                    policies.size() + " policy checked · " + inForce + " in force", "Policy administration"));
            policies.stream().filter(p -> !p.inForce())
                    .forEach(p -> doubts.add("Policy " + p.policyNumber() + " may not have been in force: " + p.note()));

            // 2. Sanctions screening. Temporal retries a timeout; the attempt count shows in the run.
            ScreenOutcome screen = act.screenParties(in.claimId());
            String screened = screen.clear() ? "all clear" : "possible match, reference " + screen.reference();
            steps.add(screen.attempts() > 1
                    ? RunStep.retried("Screen the beneficiaries", "Retried by Temporal (attempt " + screen.attempts() + ") · " + screened, "Sanctions screening")
                    : RunStep.done("Screen the beneficiaries", screened, "Sanctions screening"));
            if (!screen.clear()) doubts.add("Sanctions screening returned a possible match (" + screen.reference() + ")");

            // 3. Is there already a claim for this death?
            List<String> duplicates = act.findDuplicateClaims(in.claimId());
            steps.add(RunStep.done("Look for an existing claim", duplicates.isEmpty() ? "None for this death" : "Found " + String.join(", ", duplicates), "Postgres"));
            if (!duplicates.isEmpty()) doubts.add("Possible duplicate claim: " + String.join(", ", duplicates));

            // Anything doubtful stops the checks and opens a task for a person.
            if (!doubts.isEmpty()) {
                act.holdForReview(in.claimId(), doubts, steps);
                return new Result("needs_review", String.join("; ", doubts));
            }

            // 4. Route (rules LF-01 / LF-02) and pick the examiner.
            RouteDecision route = act.route(in.claimId());
            steps.add(RunStep.done("Route the claim", route.track() + " → " + (route.examinerName() == null ? "team queue" : route.examinerName()) + " · rule " + route.rule(), "Rules"));

            // 5. Acknowledgement and packets, then the agent.
            int sent = act.sendAcknowledgementAndPackets(in.claimId());
            steps.add(RunStep.done("Send the acknowledgement and claim packets", sent + " letters sent", "Letters and notifications"));
            boolean told = act.tellAgent(in.claimId());
            steps.add(told ? RunStep.done("Tell the agent of record", facts.agentName() + " · status only", "Notifications")
                    : RunStep.skipped("Tell the agent of record", "No consent or no agent on the claim", "Notifications"));

            // 6. One transaction saves the outcome.
            act.completeSetup(in.claimId(), route, steps);
            return new Result("set_up", route.track());
        } catch (ActivityFailure e) {
            String message = e.getCause() != null ? String.valueOf(e.getCause().getMessage()) : e.getMessage();
            act.recordFailure(in.claimId(), message, steps);
            throw e;
        }
    }
}
