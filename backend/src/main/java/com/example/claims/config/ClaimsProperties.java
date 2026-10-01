package com.example.claims.config;

import java.time.Duration;
import java.time.LocalTime;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Everything tunable, bound from the `claims.*` properties. */
@ConfigurationProperties(prefix = "claims")
public record ClaimsProperties(
        @DefaultValue Business business,
        @DefaultValue Dispatcher dispatcher,
        @DefaultValue Outbox outbox,
        @DefaultValue Temporal temporal) {

    /** Date-based deadlines (10 days, 15 days, 30 days) fall due at `fireTime` on the local date. */
    public record Business(
            @DefaultValue("America/Chicago") ZoneId zone,
            @DefaultValue("08:00") LocalTime fireTime) {}

    public record Dispatcher(
            /** Rows taken per poll. */
            @DefaultValue("25") int batchSize,
            /** Polls per run of the dispatcher workflow while batches come back full. */
            @DefaultValue("20") int maxBatchesPerRun,
            /** Backoff after a failed workflow start: retryBase * attempt, capped at retryMax. */
            @DefaultValue("30s") Duration retryBase,
            @DefaultValue("30m") Duration retryMax,
            /** Register the Temporal Schedule that runs the dispatcher every minute. */
            @DefaultValue("true") boolean scheduleEnabled,
            @DefaultValue("1m") Duration scheduleInterval,
            /** Poll from a Spring scheduler instead (dev, or a platform without Schedules). */
            @DefaultValue("false") boolean localPollEnabled,
            @DefaultValue("60s") Duration localPollInterval) {}

    public record Outbox(
            @DefaultValue("50") int batchSize,
            @DefaultValue("true") boolean pollEnabled,
            @DefaultValue("1s") Duration pollInterval,
            @DefaultValue("5s") Duration retryBase) {}

    public record Temporal(
            @DefaultValue("true") boolean enabled,
            @DefaultValue("127.0.0.1:7233") String target,
            @DefaultValue("default") String namespace,
            @DefaultValue("claims") String taskQueue,
            @DefaultValue("true") boolean workerEnabled) {}
}
