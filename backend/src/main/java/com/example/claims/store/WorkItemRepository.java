package com.example.claims.store;

import java.time.LocalDate;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class WorkItemRepository {
    private final JdbcClient jdbc;

    public WorkItemRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Idempotent by dedupe key: a retried activity cannot put a second item in the queue. */
    public boolean insertOnce(String dedupeKey, UUID ownerId, UUID claimId, int priority, String action, String why,
                              LocalDate dueOn, String waitingOn, String section, String sourceKind, UUID sourceId) {
        return jdbc.sql("""
                INSERT INTO work_items (dedupe_key, owner_id, claim_id, priority, action, why, due_on, waiting_on, section, source_kind, source_id)
                VALUES (:key, :owner, :claim, :prio, :action, :why, :due, :waiting, :section, :sk, :sid)
                ON CONFLICT (dedupe_key) DO NOTHING""")
                .param("key", dedupeKey).param("owner", ownerId).param("claim", claimId).param("prio", priority)
                .param("action", action).param("why", why).param("due", dueOn).param("waiting", waitingOn)
                .param("section", section).param("sk", sourceKind).param("sid", sourceId).update() == 1;
    }
}
