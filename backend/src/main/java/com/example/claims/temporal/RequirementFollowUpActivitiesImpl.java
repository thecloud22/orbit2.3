package com.example.claims.temporal;

import com.example.claims.deadline.FollowUpService;
import com.example.claims.domain.RunStep;
import io.temporal.activity.Activity;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class RequirementFollowUpActivitiesImpl implements RequirementFollowUpActivities {
    private final FollowUpService service;

    public RequirementFollowUpActivitiesImpl(FollowUpService service) {
        this.service = service;
    }

    private static String workflowId() { return Activity.getExecutionContext().getInfo().getWorkflowId(); }

    private static String runId() { return Activity.getExecutionContext().getInfo().getRunId(); }

    @Override
    public Check begin(UUID deadlineId) {
        return service.begin(deadlineId, workflowId(), runId());
    }

    @Override
    public void sendReminder(UUID deadlineId) {
        service.sendReminder(deadlineId, workflowId());
    }

    @Override
    public Result completeFollowUp(UUID deadlineId, List<RunStep> steps) {
        return service.complete(deadlineId, steps, workflowId(), runId());
    }

    @Override
    public Result skip(UUID deadlineId, String reason, List<RunStep> steps) {
        return service.skip(deadlineId, reason, steps, workflowId(), runId());
    }

    @Override
    public void recordFailure(UUID deadlineId, String error, List<RunStep> steps) {
        service.recordFailure(deadlineId, error, steps, workflowId(), runId());
    }
}
