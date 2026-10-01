package com.example.claims.outbox;

import com.example.claims.config.ClaimsProperties;
import com.example.claims.store.OutboxRepository;
import com.example.claims.temporal.WorkflowLauncher;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reads outbox rows saved with a change and starts the workflow for each. Same shape as the dispatcher: lock with
 * SKIP LOCKED, start (the workflow id makes a repeat a no-op), stamp published_at, commit. If the API crashed
 * after saving, the relay still starts the workflow; if the relay retries, the second start does nothing.
 * Only notice_of_death_received has a workflow in this slice; other event types stay unpublished.
 */
@Service
public class OutboxRelay {
    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    static final String NOTICE = "notice_of_death_received";

    private final OutboxRepository outbox;
    private final WorkflowLauncher launcher;
    private final TransactionTemplate tx;
    private final ClaimsProperties props;
    private final Clock clock;
    private final ObjectMapper json;

    public OutboxRelay(OutboxRepository outbox, WorkflowLauncher launcher, TransactionTemplate tx, ClaimsProperties props, Clock clock, ObjectMapper json) {
        this.outbox = outbox;
        this.launcher = launcher;
        this.tx = tx;
        this.props = props;
        this.clock = clock;
        this.json = json;
    }

    /** One pass. Returns how many events were published. */
    public int publishPending() {
        Integer n = tx.execute(status -> {
            Instant now = clock.instant();
            List<OutboxRepository.Event> events = outbox.lockUnpublished(now, props.outbox().batchSize());
            int published = 0;
            for (OutboxRepository.Event e : events) {
                if (!e.type().equals(NOTICE)) continue;    // no workflow for this type yet: leave it for later
                try {
                    JsonNode p = json.readTree(e.payload());
                    WorkflowLauncher.Started s = launcher.startIntake(p.get("claimNumber").asText(), e.claimId(), e.id());
                    outbox.markPublished(e.id(), s.workflowId(), now);
                    published++;
                } catch (Exception ex) {
                    log.warn("Could not publish outbox event {}: {}", e.id(), ex.toString());
                    outbox.markFailed(e.id(), ex.toString(), now.plus(props.outbox().retryBase().multipliedBy(Math.min(e.attempts() + 1, 12))));
                }
            }
            return published;
        });
        return n == null ? 0 : n;
    }
}
