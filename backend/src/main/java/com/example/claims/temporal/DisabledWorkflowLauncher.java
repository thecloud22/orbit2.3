package com.example.claims.temporal;

import com.example.claims.domain.DeadlineKind;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Used when claims.temporal.enabled=false (API-only runs, DB tests): starting a workflow fails loudly. */
@Component
@ConditionalOnProperty(name = "claims.temporal.enabled", havingValue = "false")
public class DisabledWorkflowLauncher implements WorkflowLauncher {
    @Override
    public Set<DeadlineKind> supportedDeadlineKinds() {
        return Set.of(DeadlineKind.REQUIREMENT_FOLLOW_UP);
    }

    @Override
    public Started startDeadlineWorkflow(DeadlineKind kind, UUID deadlineId) {
        throw new IllegalStateException("Temporal is disabled (claims.temporal.enabled=false)");
    }

    @Override
    public Started startIntake(String claimNumber, UUID claimId, UUID eventId) {
        throw new IllegalStateException("Temporal is disabled (claims.temporal.enabled=false)");
    }
}
