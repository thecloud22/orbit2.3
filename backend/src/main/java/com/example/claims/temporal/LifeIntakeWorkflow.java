package com.example.claims.temporal;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Orchestration orch-&lt;claim number&gt;-intake. Started by the outbox relay when a notice of death is saved. */
@WorkflowInterface
public interface LifeIntakeWorkflow {

    /** outcome: set_up | needs_review | already_set_up */
    record Result(String outcome, String detail) {}

    @WorkflowMethod
    Result run(LifeIntakeActivities.Input input);
}
