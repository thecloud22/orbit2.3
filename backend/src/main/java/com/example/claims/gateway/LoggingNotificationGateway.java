package com.example.claims.gateway;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** STUB. Logs instead of sending. */
@Component
public class LoggingNotificationGateway implements NotificationGateway {
    private static final Logger log = LoggerFactory.getLogger(LoggingNotificationGateway.class);

    @Override
    public String send(Message m) {
        log.info("STUB send {} {} to {} [{}] key={}", m.channel(), m.templateCode(), m.to(), m.subject(), m.idempotencyKey());
        return "stub-msg-" + Math.abs(m.idempotencyKey().hashCode());
    }
}
