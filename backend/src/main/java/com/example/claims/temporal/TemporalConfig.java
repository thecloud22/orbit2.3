package com.example.claims.temporal;

import com.example.claims.config.ClaimsProperties;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowClientOptions;
import io.temporal.client.schedules.ScheduleClient;
import io.temporal.client.schedules.ScheduleClientOptions;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Connects to the org's Temporal (we own a namespace and task queues, not a cluster). For a real namespace
 * add TLS / API-key options to the service stubs here; local dev talks plain gRPC to the dev server.
 */
@Configuration
@ConditionalOnProperty(name = "claims.temporal.enabled", havingValue = "true", matchIfMissing = true)
public class TemporalConfig {

    @Bean(destroyMethod = "shutdown")
    WorkflowServiceStubs workflowServiceStubs(ClaimsProperties props) {
        return WorkflowServiceStubs.newServiceStubs(WorkflowServiceStubsOptions.newBuilder()
                .setTarget(props.temporal().target()).build());
    }

    @Bean
    WorkflowClient workflowClient(WorkflowServiceStubs stubs, ClaimsProperties props) {
        return WorkflowClient.newInstance(stubs, WorkflowClientOptions.newBuilder().setNamespace(props.temporal().namespace()).build());
    }

    @Bean
    ScheduleClient scheduleClient(WorkflowServiceStubs stubs, ClaimsProperties props) {
        return ScheduleClient.newInstance(stubs, ScheduleClientOptions.newBuilder().setNamespace(props.temporal().namespace()).build());
    }

    @Bean
    @ConditionalOnProperty(name = "claims.temporal.worker-enabled", havingValue = "true", matchIfMissing = true)
    TemporalWorkerLifecycle temporalWorker(WorkflowClient client, ClaimsProperties props, LifeIntakeActivitiesImpl intake,
                                           RequirementFollowUpActivitiesImpl followUp, DispatcherActivitiesImpl dispatcher) {
        WorkerFactory factory = WorkerFactory.newInstance(client);
        Worker worker = factory.newWorker(props.temporal().taskQueue());
        registerAll(worker, intake, followUp, dispatcher);
        return new TemporalWorkerLifecycle(factory);
    }

    /** Shared with the tests, which register the same classes on a test environment's worker. */
    public static void registerAll(Worker worker, Object... activities) {
        worker.registerWorkflowImplementationTypes(LifeIntakeWorkflowImpl.class, RequirementFollowUpWorkflowImpl.class,
                DeadlineDispatcherWorkflowImpl.class);
        worker.registerActivitiesImplementations(activities);
    }
}
