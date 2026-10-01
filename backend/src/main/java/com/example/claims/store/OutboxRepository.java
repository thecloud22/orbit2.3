package com.example.claims.store;

import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class OutboxRepository {

    public record Event(UUID id, UUID claimId, String type, String payload, int attempts) {}

    private final JdbcClient jdbc;

    public OutboxRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public UUID insert(UUID claimId, String type, String payloadJson) {
        return jdbc.sql("INSERT INTO outbox_events (claim_id, event_type, payload) VALUES (:c, :t, cast(:p as jsonb)) RETURNING id")
                .param("c", claimId).param("t", type).param("p", payloadJson).query((rs, n) -> uuid(rs, "id")).single();
    }

    /** Oldest unpublished events, locked so two relays never publish the same one. */
    public List<Event> lockUnpublished(Instant now, int limit) {
        return jdbc.sql("""
                SELECT id, claim_id, event_type, payload::text AS payload, publish_attempts FROM outbox_events
                WHERE published_at IS NULL AND (retry_after IS NULL OR retry_after <= :now)
                ORDER BY created_at, id LIMIT :limit FOR UPDATE SKIP LOCKED""")
                .param("now", ts(now)).param("limit", limit)
                .query((rs, n) -> new Event(uuid(rs, "id"), uuid(rs, "claim_id"), rs.getString("event_type"),
                        rs.getString("payload"), rs.getInt("publish_attempts")))
                .list();
    }

    public void markPublished(UUID id, String workflowId, Instant now) {
        jdbc.sql("UPDATE outbox_events SET published_at = :now, workflow_id = :wf, publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = :id")
                .param("now", ts(now)).param("wf", workflowId).param("id", id).update();
    }

    public void markFailed(UUID id, String error, Instant retryAfter) {
        jdbc.sql("UPDATE outbox_events SET publish_attempts = publish_attempts + 1, last_error = :e, retry_after = :r WHERE id = :id")
                .param("e", error == null ? null : error.substring(0, Math.min(error.length(), 1000))).param("r", ts(retryAfter)).param("id", id).update();
    }
}
