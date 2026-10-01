package com.example.claims.outbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "claims.outbox.poll-enabled", havingValue = "true", matchIfMissing = true)
public class OutboxPoller {
    private static final Logger log = LoggerFactory.getLogger(OutboxPoller.class);
    private final OutboxRelay relay;

    public OutboxPoller(OutboxRelay relay) {
        this.relay = relay;
    }

    @Scheduled(fixedDelayString = "${claims.outbox.poll-interval:1s}")
    public void poll() {
        try {
            relay.publishPending();
        } catch (RuntimeException e) {
            log.error("Outbox relay pass failed", e);
        }
    }
}
