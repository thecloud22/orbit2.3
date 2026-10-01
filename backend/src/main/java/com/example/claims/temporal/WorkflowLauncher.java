package com.example.claims.temporal;

import com.example.claims.domain.DeadlineKind;
import java.util.Set;
import java.util.UUID;

/**
 * The one seam between our code and Temporal for STARTING workflows. The dispatcher and the outbox relay only
 * know this interface, which is what lets them be tested (and run) without a Temporal server.
 */
public interface WorkflowLauncher {

    enum Outcome { STARTED, ALREADY_STARTED }

    record Started(String workflowId, Outcome outcome) {}

    /** Deadline kinds that have a workflow. The dispatcher leaves rows of other kinds alone. */
    Set<DeadlineKind> supportedDeadlineKinds();

    /** Starts deadline-&lt;id&gt;. A second start with the same id must not start a second workflow. */
    Started startDeadlineWorkflow(DeadlineKind kind, UUID deadlineId);

    /** Starts orch-&lt;claim number&gt;-intake. */
    Started startIntake(String claimNumber, UUID claimId, UUID eventId);

    static String deadlineWorkflowId(UUID deadlineId) { return "deadline-" + deadlineId; }

    static String intakeWorkflowId(String claimNumber) { return "orch-" + claimNumber + "-intake"; }
}
