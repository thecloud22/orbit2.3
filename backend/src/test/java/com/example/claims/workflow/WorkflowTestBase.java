package com.example.claims.workflow;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;

/** A Temporal test environment with time skipping: activity retry back-offs cost no wall-clock time. */
abstract class WorkflowTestBase {
    static final String TASK_QUEUE = "claims-test";

    TestWorkflowEnvironment env;
    Worker worker;
    WorkflowClient client;

    @BeforeEach
    void startEnvironment() {
        env = TestWorkflowEnvironment.newInstance();
        worker = env.newWorker(TASK_QUEUE);
        client = env.getWorkflowClient();
    }

    @AfterEach
    void stopEnvironment() {
        env.close();
    }

    <T> T stub(Class<T> type, String workflowId) {
        return client.newWorkflowStub(type, WorkflowOptions.newBuilder().setTaskQueue(TASK_QUEUE).setWorkflowId(workflowId).build());
    }

    static UUID id() { return UUID.randomUUID(); }
}
