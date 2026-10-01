package com.example.claims.temporal;

import com.example.claims.config.ClaimsProperties;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.schedules.Schedule;
import io.temporal.client.schedules.ScheduleActionStartWorkflow;
import io.temporal.client.schedules.ScheduleAlreadyRunningException;
import io.temporal.client.schedules.ScheduleClient;
import io.temporal.client.schedules.ScheduleIntervalSpec;
import io.temporal.client.schedules.ScheduleOptions;
import io.temporal.client.schedules.SchedulePolicy;
import io.temporal.client.schedules.ScheduleSpec;
import io.temporal.api.enums.v1.ScheduleOverlapPolicy;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Creates the Temporal Schedule that runs the dispatcher workflow every minute, once per namespace. Creating it
 * again is a no-op. Overlap policy SKIP: if a run is still going when the next tick arrives, the tick is dropped
 * (the next one will pick the rows up), so runs never pile up.
 * NOT verified against a real server in this repo: the in-process test server does not implement Schedules.
 */
@Component
@ConditionalOnBean(ScheduleClient.class)
@ConditionalOnProperty(name = "claims.dispatcher.schedule-enabled", havingValue = "true", matchIfMissing = true)
public class DispatcherScheduleRegistrar implements ApplicationRunner {
    static final String SCHEDULE_ID = "claims-deadline-dispatcher";
    private static final Logger log = LoggerFactory.getLogger(DispatcherScheduleRegistrar.class);

    private final ScheduleClient scheduleClient;
    private final ClaimsProperties props;

    public DispatcherScheduleRegistrar(ScheduleClient scheduleClient, ClaimsProperties props) {
        this.scheduleClient = scheduleClient;
        this.props = props;
    }

    @Override
    public void run(ApplicationArguments args) {
        Schedule schedule = Schedule.newBuilder()
                .setAction(ScheduleActionStartWorkflow.newBuilder()
                        .setWorkflowType(DeadlineDispatcherWorkflow.class)
                        .setOptions(WorkflowOptions.newBuilder()
                                .setWorkflowId("deadline-dispatcher")
                                .setTaskQueue(props.temporal().taskQueue())
                                .build())
                        .build())
                .setSpec(ScheduleSpec.newBuilder()
                        .setIntervals(List.of(new ScheduleIntervalSpec(props.dispatcher().scheduleInterval())))
                        .build())
                .setPolicy(SchedulePolicy.newBuilder().setOverlap(ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_SKIP).build())
                .build();
        try {
            scheduleClient.createSchedule(SCHEDULE_ID, schedule, ScheduleOptions.newBuilder().build());
            log.info("Created Temporal Schedule {} every {}", SCHEDULE_ID, props.dispatcher().scheduleInterval());
        } catch (ScheduleAlreadyRunningException e) {
            log.info("Temporal Schedule {} already exists", SCHEDULE_ID);
        }
    }
}
