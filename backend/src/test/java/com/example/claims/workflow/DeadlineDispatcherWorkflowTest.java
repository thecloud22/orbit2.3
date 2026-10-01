package com.example.claims.workflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.claims.temporal.DeadlineDispatcherWorkflow;
import com.example.claims.temporal.DeadlineDispatcherWorkflowImpl;
import com.example.claims.temporal.DispatcherActivities;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class DeadlineDispatcherWorkflowTest extends WorkflowTestBase {

    @Test
    void keepsPollingWhileBatchesComeBackFullThenStops() {
        AtomicInteger polls = new AtomicInteger();
        worker.registerWorkflowImplementationTypes(DeadlineDispatcherWorkflowImpl.class);
        worker.registerActivitiesImplementations((DispatcherActivities) () -> {
            int n = polls.incrementAndGet();
            return n < 3 ? new DispatcherActivities.Summary(25, 25, 0, 0, true) : new DispatcherActivities.Summary(7, 6, 1, 0, false);
        });
        env.start();

        DeadlineDispatcherWorkflow.Total t = stub(DeadlineDispatcherWorkflow.class, "deadline-dispatcher").run();

        assertThat(t.batches()).isEqualTo(3);
        assertThat(t.claimed()).isEqualTo(57);
        assertThat(t.started()).isEqualTo(56);
        assertThat(t.alreadyStarted()).isEqualTo(1);
    }

    @Test
    void neverLoopsForeverEvenIfEveryBatchIsFull() {
        AtomicInteger polls = new AtomicInteger();
        worker.registerWorkflowImplementationTypes(DeadlineDispatcherWorkflowImpl.class);
        worker.registerActivitiesImplementations((DispatcherActivities) () -> {
            polls.incrementAndGet();
            return new DispatcherActivities.Summary(25, 25, 0, 0, true);
        });
        env.start();

        DeadlineDispatcherWorkflow.Total t = stub(DeadlineDispatcherWorkflow.class, "deadline-dispatcher").run();

        assertThat(t.batches()).isEqualTo(20);      // the rest waits for the next minute's run
        assertThat(polls.get()).isEqualTo(20);
    }
}
