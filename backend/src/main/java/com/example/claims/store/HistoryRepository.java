package com.example.claims.store;

import static com.example.claims.common.Db.ts;

import com.example.claims.common.Actor;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Append-only audit trail. There is deliberately no update or delete here (or in the database). */
@Repository
public class HistoryRepository {
    private final JdbcClient jdbc;

    public HistoryRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void append(UUID claimId, Instant occurredAt, String type, String title, Actor actor, String detail, String ref, String workflowId) {
        jdbc.sql("""
                INSERT INTO history_events (claim_id, occurred_at, type, title, actor_kind, actor, detail, ref, workflow_id)
                VALUES (:claim, :at, :type, :title, :kind, :actor, :detail, :ref, :wf)""")
                .param("claim", claimId).param("at", ts(occurredAt)).param("type", type).param("title", title)
                .param("kind", actor.kind()).param("actor", actor.name()).param("detail", detail).param("ref", ref)
                .param("wf", workflowId)
                .update();
    }
}
