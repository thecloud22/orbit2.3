package com.example.claims.store;

import static com.example.claims.common.Db.instant;
import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import com.example.claims.common.Db;
import com.example.claims.domain.RunStep;
import com.example.claims.view.Views.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** The read side: every GET the API serves. Plain SQL, no writes. */
@Repository
public class ClaimQueries {
    private final JdbcClient jdbc;
    private final ObjectMapper json;

    public ClaimQueries(JdbcClient jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    // ------------------------------------------------------------------ claims

    public Optional<ClaimView> claim(UUID id) {
        return jdbc.sql("""
                SELECT c.*, p.full_name AS insured_name, d.*
                FROM claims c
                JOIN parties p ON p.id = c.insured_party_id
                LEFT JOIN life_claim_details d ON d.claim_id = c.id
                WHERE c.id = :id""")
                .param("id", id)
                .query((rs, n) -> new ClaimView(
                        uuid(rs, "id"), rs.getString("claim_number"), rs.getString("family"), rs.getString("product_code"),
                        rs.getString("status"), rs.getString("track"), rs.getString("route_rule"), Db.textArray(rs, "route_reasons"),
                        uuid(rs, "owner_id"), rs.getString("team"), instant(rs, "noticed_at"), instant(rs, "proof_complete_at"),
                        instant(rs, "closed_at"), new PartyRef(uuid(rs, "insured_party_id"), rs.getString("insured_name")),
                        rs.getObject("claim_id") == null ? null : life(rs), List.of(), List.of(),
                        rs.getLong("version"), instant(rs, "created_at"), instant(rs, "updated_at")))
                .optional()
                .map(c -> new ClaimView(c.id(), c.claimNumber(), c.family(), c.productCode(), c.status(), c.track(), c.routeRule(),
                        c.routeReasons(), c.ownerId(), c.team(), c.noticedAt(), c.proofCompleteAt(), c.closedAt(), c.insured(),
                        c.details(), benefitLines(id), parties(id), c.version(), c.createdAt(), c.updatedAt()));
    }

    private LifeDetails life(ResultSet rs) throws SQLException {
        return new LifeDetails("life", Db.date(rs, "date_of_death"), rs.getString("place_of_death"), rs.getString("manner_of_death"),
                rs.getBoolean("death_outside_us"), rs.getString("funeral_home"), uuid(rs, "caller_party_id"),
                rs.getString("caller_relationship"), Db.textArray(rs, "contact_by"), rs.getBoolean("agent_consent"),
                rs.getBoolean("other_claimants_possible"), rs.getString("intake_channel"));
    }

    private List<BenefitLineView> benefitLines(UUID claimId) {
        return jdbc.sql("""
                SELECT b.*, pol.policy_number FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id
                WHERE b.claim_id = :c ORDER BY b.kind, b.created_at, b.id""")
                .param("c", claimId)
                .query((rs, n) -> new BenefitLineView(uuid(rs, "id"), rs.getString("policy_number"), rs.getString("kind"),
                        uuid(rs, "parent_line_id"), rs.getString("rider_key"), rs.getString("name"),
                        Money.of(rs.getBigDecimal("amount"), rs.getString("currency")), rs.getString("status"),
                        rs.getString("waiting_on"), rs.getString("product_config_version"), rs.getLong("version")))
                .list();
    }

    private List<ClaimPartyView> parties(UUID claimId) {
        return jdbc.sql("""
                SELECT cp.*, p.full_name, p.date_of_death FROM claim_parties cp JOIN parties p ON p.id = cp.party_id
                WHERE cp.claim_id = :c ORDER BY cp.created_at, p.full_name, cp.role""")
                .param("c", claimId)
                .query((rs, n) -> new ClaimPartyView(uuid(rs, "party_id"), rs.getString("full_name"), rs.getString("role"),
                        rs.getString("relationship"), rs.getString("beneficiary_kind"),
                        rs.getBigDecimal("share_percent") == null ? null : rs.getBigDecimal("share_percent").toPlainString(),
                        rs.getBoolean("payee"), rs.getString("packet_channel"), rs.getString("access_note"), Db.date(rs, "date_of_death")))
                .list();
    }

    /** GET /claims — newest first, keyset paginated. */
    public Page<ClaimSummary> claims(UUID owner, String status, String family, String claimNumber, int limit, String cursor) {
        StringBuilder sql = new StringBuilder("""
                SELECT c.id, c.claim_number, c.family, c.product_code, c.status, c.track, c.owner_id, c.noticed_at, c.created_at,
                       c.version, p.full_name AS insured_name
                FROM claims c JOIN parties p ON p.id = c.insured_party_id WHERE true""");
        List<Object> args = new ArrayList<>();
        if (owner != null) { sql.append(" AND c.owner_id = ?"); args.add(owner); }
        if (status != null) { sql.append(" AND c.status = ?"); args.add(status); }
        if (family != null) { sql.append(" AND c.family = ?"); args.add(family); }
        if (claimNumber != null) { sql.append(" AND c.claim_number = ?"); args.add(claimNumber); }
        if (cursor != null) {
            Cursor c = Cursor.decode(cursor);
            sql.append(" AND (c.created_at, c.id) < (?, ?)");
            args.add(ts(c.at()));
            args.add(UUID.fromString(c.tie()));
        }
        sql.append(" ORDER BY c.created_at DESC, c.id DESC LIMIT ?");
        args.add(limit + 1);
        List<Instant> created = new ArrayList<>();
        List<ClaimSummary> rows = jdbc.sql(sql.toString()).params(args).query((rs, n) -> {
            created.add(instant(rs, "created_at"));
            return new ClaimSummary(uuid(rs, "id"), rs.getString("claim_number"), rs.getString("family"), rs.getString("product_code"),
                    rs.getString("status"), rs.getString("track"), uuid(rs, "owner_id"), rs.getString("insured_name"),
                    instant(rs, "noticed_at"), rs.getLong("version"));
        }).list();
        if (rows.size() <= limit) return new Page<>(rows, null);
        ClaimSummary last = rows.get(limit - 1);
        return new Page<>(rows.subList(0, limit), new Cursor(created.get(limit - 1), last.id().toString()).encode());
    }

    // ------------------------------------------------------------------ requirements

    private static RequirementView requirement(ResultSet rs) throws SQLException {
        return new RequirementView(uuid(rs, "id"), uuid(rs, "claim_id"), uuid(rs, "benefit_line_id"), rs.getString("key"),
                rs.getString("name"), rs.getString("purpose"),
                new RequirementSource(uuid(rs, "from_party_id"), rs.getString("from_label"), rs.getString("from_detail")),
                rs.getString("state"), instant(rs, "requested_at"), rs.getInt("follow_up_days"), rs.getInt("follow_up_count"),
                instant(rs, "last_reminder_at"), instant(rs, "received_at"), instant(rs, "accepted_at"), rs.getString("satisfied_by"),
                instant(rs, "waived_at"), rs.getString("waive_reason"), rs.getLong("version"));
    }

    public List<RequirementView> requirements(UUID claimId) {
        return jdbc.sql("SELECT * FROM requirements WHERE claim_id = :c ORDER BY created_at, id")
                .param("c", claimId).query((rs, n) -> requirement(rs)).list();
    }

    public Optional<RequirementView> requirement(UUID id) {
        return jdbc.sql("SELECT * FROM requirements WHERE id = :id").param("id", id).query((rs, n) -> requirement(rs)).optional();
    }

    // ------------------------------------------------------------------ deadlines

    private static DeadlineView deadline(ResultSet rs) throws SQLException {
        return new DeadlineView(uuid(rs, "id"), uuid(rs, "claim_id"), rs.getString("kind"), uuid(rs, "requirement_id"),
                rs.getString("what"), rs.getString("sla"), instant(rs, "due_at"), instant(rs, "original_due_at"),
                rs.getString("extension_reason"), rs.getString("state"), rs.getInt("attempt"), instant(rs, "dispatched_at"),
                rs.getBoolean("fired"), rs.getString("last_outcome"), rs.getString("last_error"), rs.getString("workflow_id"),
                instant(rs, "closed_at"), rs.getString("closed_by"), rs.getString("result"), rs.getLong("version"));
    }

    public List<DeadlineView> deadlines(UUID claimId) {
        return jdbc.sql("SELECT * FROM deadlines WHERE claim_id = :c ORDER BY created_at, due_at, id")
                .param("c", claimId).query((rs, n) -> deadline(rs)).list();
    }

    public Optional<DeadlineView> deadline(UUID id) {
        return jdbc.sql("SELECT * FROM deadlines WHERE id = :id").param("id", id).query((rs, n) -> deadline(rs)).optional();
    }

    /** GET /deadlines — the operations view: what is open, overdue or stuck across claims. */
    public List<DeadlineView> deadlines(String state, String kind, Instant dueBefore, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM deadlines WHERE true");
        List<Object> args = new ArrayList<>();
        if (state != null) { sql.append(" AND state = ?"); args.add(state); }
        if (kind != null) { sql.append(" AND kind = ?"); args.add(kind); }
        if (dueBefore != null) { sql.append(" AND due_at <= ?"); args.add(ts(dueBefore)); }
        sql.append(" ORDER BY due_at, id LIMIT ?");
        args.add(limit);
        return jdbc.sql(sql.toString()).params(args).query((rs, n) -> deadline(rs)).list();
    }

    // ------------------------------------------------------------------ letters, history, work, runs

    public List<LetterView> letters(UUID claimId) {
        return jdbc.sql("SELECT * FROM letters WHERE claim_id = :c ORDER BY created_at DESC, id DESC").param("c", claimId)
                .query((rs, n) -> new LetterView(uuid(rs, "id"), uuid(rs, "claim_id"), uuid(rs, "benefit_line_id"),
                        rs.getString("template_code"), rs.getString("channel"), uuid(rs, "recipient_party_id"),
                        rs.getString("recipient_label"), rs.getString("subject"), rs.getString("summary"), rs.getString("status"),
                        instant(rs, "sent_at"), rs.getString("workflow_id"), instant(rs, "created_at")))
                .list();
    }

    /** GET /claims/{id}/history — newest first, keyset paginated on (occurred_at, seq). */
    public Page<HistoryEventView> history(UUID claimId, int limit, String cursor) {
        StringBuilder sql = new StringBuilder("SELECT *, seq AS s FROM history_events WHERE claim_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(claimId);
        if (cursor != null) {
            Cursor c = Cursor.decode(cursor);
            sql.append(" AND (occurred_at, seq) < (?, ?)");
            args.add(ts(c.at()));
            args.add(Long.parseLong(c.tie()));
        }
        sql.append(" ORDER BY occurred_at DESC, seq DESC LIMIT ?");
        args.add(limit + 1);
        List<Cursor> keys = new ArrayList<>();
        List<HistoryEventView> rows = jdbc.sql(sql.toString()).params(args).query((rs, n) -> {
            keys.add(new Cursor(instant(rs, "occurred_at"), Long.toString(rs.getLong("s"))));
            return new HistoryEventView(uuid(rs, "id"), uuid(rs, "claim_id"), instant(rs, "occurred_at"), instant(rs, "recorded_at"),
                    rs.getString("type"), rs.getString("title"), rs.getString("actor_kind"), rs.getString("actor"),
                    rs.getString("detail"), rs.getString("ref"), rs.getString("workflow_id"));
        }).list();
        if (rows.size() <= limit) return new Page<>(rows, null);
        return new Page<>(rows.subList(0, limit), keys.get(limit - 1).encode());
    }

    public List<WorkItemView> workItems(UUID owner, String status, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM work_items WHERE true");
        List<Object> args = new ArrayList<>();
        if (owner != null) { sql.append(" AND owner_id = ?"); args.add(owner); }
        if (status != null) { sql.append(" AND status = ?"); args.add(status); }
        sql.append(" ORDER BY priority, due_on, created_at, id LIMIT ?");
        args.add(limit);
        return jdbc.sql(sql.toString()).params(args)
                .query((rs, n) -> new WorkItemView(uuid(rs, "id"), uuid(rs, "owner_id"), uuid(rs, "claim_id"), rs.getInt("priority"),
                        rs.getString("action"), rs.getString("why"), Db.date(rs, "due_on"), rs.getString("waiting_on"),
                        rs.getString("flag"), rs.getString("section"), rs.getString("status"), rs.getLong("version")))
                .list();
    }

    public List<WorkflowRunView> workflowRuns(UUID claimId) {
        return jdbc.sql("SELECT * FROM workflow_runs WHERE claim_id = :c ORDER BY started_at, id").param("c", claimId)
                .query((rs, n) -> new WorkflowRunView(uuid(rs, "id"), rs.getString("workflow_id"), rs.getString("run_id"),
                        rs.getString("type"), rs.getString("name"), uuid(rs, "claim_id"), rs.getString("started_by"),
                        rs.getString("trigger_kind"), uuid(rs, "trigger_id"), rs.getString("status"), instant(rs, "started_at"),
                        instant(rs, "finished_at"), steps(rs.getString("steps")), Db.textArray(rs, "saved"), rs.getString("error")))
                .list();
    }

    private List<RunStep> steps(String jsonText) {
        try {
            return json.readValue(jsonText, new TypeReference<List<RunStep>>() {});
        } catch (Exception e) {
            throw new IllegalStateException("Bad steps json in workflow_runs", e);
        }
    }
}
