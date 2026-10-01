package com.example.claims.temporal;

import com.example.claims.domain.RunStep;
import com.example.claims.temporal.RequirementFollowUpActivities.Check;
import com.example.claims.temporal.RequirementFollowUpActivities.Result;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.workflow.Workflow;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Short by design: no timers, no waiting for the requirement to arrive. If it has arrived by the time this
 * runs, the workflow skips; if not, it reminds and writes the NEXT follow-up as a new deadline row, which
 * the dispatcher will fire later. "Stop when the requirement is met" therefore means: nothing is left
 * scheduled once the requirement is accepted or waived.
 */
public class RequirementFollowUpWorkflowImpl implements RequirementFollowUpWorkflow {

    private final RequirementFollowUpActivities act = Workflow.newActivityStub(RequirementFollowUpActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(30))
                    .setRetryOptions(RetryOptions.newBuilder()
                            .setInitialInterval(Duration.ofSeconds(2)).setBackoffCoefficient(2.0)
                            .setMaximumInterval(Duration.ofSeconds(30)).setMaximumAttempts(5).build())
                    .build());

    @Override
    public Result run(UUID deadlineId) {
        List<RunStep> steps = new ArrayList<>();
        try {
            Check check = act.begin(deadlineId);
            steps.add(RunStep.done("Re-check: is it still missing?", check.applies() ? "Yes: " + check.requirementName() : check.reason(), "Postgres"));
            if (!check.applies()) {
                return act.skip(deadlineId, check.reason(), steps);
            }
            act.sendReminder(deadlineId);
            steps.add(RunStep.done("Send a reminder", check.recipient() + " by " + check.channel(), "Notifications"));
            return act.completeFollowUp(deadlineId, steps);
        } catch (ActivityFailure e) {
            String message = e.getCause() != null ? String.valueOf(e.getCause().getMessage()) : e.getMessage();
            act.recordFailure(deadlineId, message, steps);
            throw e;
        }
    }
}
