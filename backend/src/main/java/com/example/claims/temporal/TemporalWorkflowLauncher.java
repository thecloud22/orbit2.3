package com.example.claims.temporal;

import com.example.claims.config.ClaimsProperties;
import com.example.claims.domain.DeadlineKind;
import io.temporal.api.enums.v1.WorkflowIdReusePolicy;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowOptions;
import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Starts workflows on the org's Temporal namespace and task queue. Workflow ids are the idempotency key:
 * ALLOW_DUPLICATE_FAILED_ONLY means a completed or running workflow with the same id makes the second start a
 * no-op (reported as ALREADY_STARTED), while a failed one can be started again.
 */
@Component
@ConditionalOnProperty(name = "claims.temporal.enabled", havingValue = "true", matchIfMissing = true)
public class TemporalWorkflowLauncher implements WorkflowLauncher {
    private final WorkflowClient client;
    private final String taskQueue;

    public TemporalWorkflowLauncher(WorkflowClient client, ClaimsProperties props) {
        this.client = client;
        this.taskQueue = props.temporal().taskQueue();
    }

    private WorkflowOptions options(String workflowId, Duration timeout) {
        return WorkflowOptions.newBuilder()
                .setWorkflowId(workflowId)
                .setTaskQueue(taskQueue)
                .setWorkflowExecutionTimeout(timeout)
                .setWorkflowIdReusePolicy(WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY)
                .build();
    }

    @Override
    public Set<DeadlineKind> supportedDeadlineKinds() {
        return Set.of(DeadlineKind.REQUIREMENT_FOLLOW_UP);
    }

    @Override
    public Started startDeadlineWorkflow(DeadlineKind kind, UUID deadlineId) {
        String id = WorkflowLauncher.deadlineWorkflowId(deadlineId);
        if (kind != DeadlineKind.REQUIREMENT_FOLLOW_UP) throw new IllegalArgumentException("No workflow for deadline kind " + kind);
        RequirementFollowUpWorkflow wf = client.newWorkflowStub(RequirementFollowUpWorkflow.class, options(id, Duration.ofHours(1)));
        try {
            WorkflowClient.start(wf::run, deadlineId);
            return new Started(id, Outcome.STARTED);
        } catch (WorkflowExecutionAlreadyStarted e) {
            return new Started(id, Outcome.ALREADY_STARTED);
        }
    }

    @Override
    public Started startIntake(String claimNumber, UUID claimId, UUID eventId) {
        String id = WorkflowLauncher.intakeWorkflowId(claimNumber);
        LifeIntakeWorkflow wf = client.newWorkflowStub(LifeIntakeWorkflow.class, options(id, Duration.ofHours(6)));
        try {
            WorkflowClient.start(wf::run, new LifeIntakeActivities.Input(claimId, eventId));
            return new Started(id, Outcome.STARTED);
        } catch (WorkflowExecutionAlreadyStarted e) {
            return new Started(id, Outcome.ALREADY_STARTED);
        }
    }
}
