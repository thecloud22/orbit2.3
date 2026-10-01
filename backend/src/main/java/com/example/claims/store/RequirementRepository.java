package com.example.claims.store;

import static com.example.claims.common.Db.instant;
import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import com.example.claims.domain.RequirementState;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class RequirementRepository {

    public record Row(UUID id, UUID claimId, String name, String key, RequirementState state, int followUpDays,
                      int followUpCount, UUID fromPartyId, String fromLabel, long version) {}

    private final JdbcClient jdbc;

    public RequirementRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    private static Row row(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Row(uuid(rs, "id"), uuid(rs, "claim_id"), rs.getString("name"), rs.getString("key"),
                RequirementState.of(rs.getString("state")), rs.getInt("follow_up_days"), rs.getInt("follow_up_count"),
                uuid(rs, "from_party_id"), rs.getString("from_label"), rs.getLong("version"));
    }

    private static final String COLS = "id, claim_id, name, key, state, follow_up_days, follow_up_count, from_party_id, from_label, version";

    public Optional<Row> find(UUID id) {
        return jdbc.sql("SELECT " + COLS + " FROM requirements WHERE id = :id").param("id", id).query(RequirementRepository::row).optional();
    }

    /** Lock order in this codebase: requirement first, then its deadline rows. */
    public Optional<Row> lock(UUID id) {
        return jdbc.sql("SELECT " + COLS + " FROM requirements WHERE id = :id FOR UPDATE").param("id", id).query(RequirementRepository::row).optional();
    }

    public void markAccepted(UUID id, String satisfiedBy, Instant now) {
        jdbc.sql("UPDATE requirements SET state = 'accepted', accepted_at = :now, received_at = COALESCE(received_at, :now), satisfied_by = :by WHERE id = :id")
                .param("now", ts(now)).param("by", satisfiedBy).param("id", id).update();
    }

    public void markWaived(UUID id, String reason, String by, Instant now) {
        jdbc.sql("UPDATE requirements SET state = 'waived', waived_at = :now, waive_reason = :reason, waived_by = :by WHERE id = :id")
                .param("now", ts(now)).param("reason", reason).param("by", by).param("id", id).update();
    }

    public void recordReminder(UUID id, Instant now) {
        jdbc.sql("UPDATE requirements SET follow_up_count = follow_up_count + 1, last_reminder_at = :now WHERE id = :id")
                .param("now", ts(now)).param("id", id).update();
    }

    /** Requirements on the claim that are not yet accepted or waived. */
    public int countUnmet(UUID claimId) {
        return jdbc.sql("SELECT count(*) FROM requirements WHERE claim_id = :c AND state NOT IN ('accepted', 'waived')")
                .param("c", claimId).query(Integer.class).single();
    }
}
