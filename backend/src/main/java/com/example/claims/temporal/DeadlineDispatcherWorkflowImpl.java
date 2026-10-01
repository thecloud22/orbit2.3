package com.example.claims.temporal;

import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.workflow.Workflow;
import java.time.Duration;

public class DeadlineDispatcherWorkflowImpl implements DeadlineDispatcherWorkflow {
    private static final int MAX_BATCHES = 20;

    private final DispatcherActivities act = Workflow.newActivityStub(DispatcherActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(120))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build())
                    .build());

    @Override
    public Total run() {
        int batches = 0, claimed = 0, started = 0, already = 0, failed = 0;
        while (batches < MAX_BATCHES) {
            DispatcherActivities.Summary s = act.dispatchDue();
            batches++;
            claimed += s.claimed();
            started += s.started();
            already += s.alreadyStarted();
            failed += s.failed();
            if (!s.more()) break;
        }
        return new Total(batches, claimed, started, already, failed);
    }
}
