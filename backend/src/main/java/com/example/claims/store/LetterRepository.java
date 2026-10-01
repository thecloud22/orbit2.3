package com.example.claims.store;

import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class LetterRepository {

    public record NewLetter(UUID claimId, String templateCode, String channel, UUID recipientPartyId, String recipientLabel,
                            String subject, String summary, String sourceKind, UUID sourceId, String workflowId, String dedupeKey) {}

    public record Row(UUID id, String status, String providerMessageId) {}

    private final JdbcClient jdbc;

    public LetterRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Inserts the letter as queued; returns empty when a letter with this dedupe key already exists. */
    public Optional<UUID> insertQueued(NewLetter l) {
        return jdbc.sql("""
                INSERT INTO letters (claim_id, template_code, channel, recipient_party_id, recipient_label, subject, summary,
                                     source_kind, source_id, workflow_id, dedupe_key)
                VALUES (:claim, :tpl, :channel, :party, :label, :subject, :summary, :sk, :sid, :wf, :key)
                ON CONFLICT (dedupe_key) DO NOTHING RETURNING id""")
                .param("claim", l.claimId()).param("tpl", l.templateCode()).param("channel", l.channel())
                .param("party", l.recipientPartyId()).param("label", l.recipientLabel()).param("subject", l.subject())
                .param("summary", l.summary()).param("sk", l.sourceKind()).param("sid", l.sourceId())
                .param("wf", l.workflowId()).param("key", l.dedupeKey())
                .query((rs, n) -> uuid(rs, "id")).optional();
    }

    public Row byDedupeKey(String key) {
        return jdbc.sql("SELECT id, status, provider_message_id FROM letters WHERE dedupe_key = :k").param("k", key)
                .query((rs, n) -> new Row(uuid(rs, "id"), rs.getString("status"), rs.getString("provider_message_id"))).single();
    }

    public void markSent(UUID id, String messageId, Instant at) {
        jdbc.sql("UPDATE letters SET status = 'sent', sent_at = :at, provider_message_id = :m WHERE id = :id AND status <> 'sent'")
                .param("at", ts(at)).param("m", messageId).param("id", id).update();
    }
}
