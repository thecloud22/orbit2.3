package com.example.claims.deadline;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Optional in-process trigger for the dispatcher (claims.dispatcher.local-poll-enabled=true). In production the
 * Temporal Schedule triggers it; this is for local dev and for a platform without Schedules (an open question in
 * the architecture). Safe alongside the Schedule: SKIP LOCKED keeps them from taking the same rows.
 */
@Component
@ConditionalOnProperty(name = "claims.dispatcher.local-poll-enabled", havingValue = "true")
public class LocalDispatcherPoller {
    private static final Logger log = LoggerFactory.getLogger(LocalDispatcherPoller.class);
    private final DeadlineDispatcher dispatcher;

    public LocalDispatcherPoller(DeadlineDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    @Scheduled(fixedDelayString = "${claims.dispatcher.local-poll-interval:60s}")
    public void poll() {
        try {
            DeadlineDispatcher.Result r = dispatcher.dispatchDue();
            if (r.claimed() > 0) log.info("Dispatcher: {}", r);
        } catch (RuntimeException e) {
            log.error("Dispatcher poll failed", e);
        }
    }
}
