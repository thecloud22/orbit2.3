package com.example.claims.temporal;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Run by a Temporal Schedule every minute. Not a long-running loop: each run polls and ends. */
@WorkflowInterface
public interface DeadlineDispatcherWorkflow {

    record Total(int batches, int claimed, int started, int alreadyStarted, int failed) {}

    @WorkflowMethod
    Total run();
}
