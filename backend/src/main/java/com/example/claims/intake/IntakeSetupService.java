package com.example.claims.intake;

import static com.example.claims.common.Db.uuid;

import com.example.claims.common.Actor;
import com.example.claims.common.BusinessCalendar;
import com.example.claims.common.Db;
import com.example.claims.domain.RunStep;
import com.example.claims.store.HistoryRepository;
import com.example.claims.store.LetterRepository.NewLetter;
import com.example.claims.store.LetterService;
import com.example.claims.store.WorkItemRepository;
import com.example.claims.store.WorkflowRunRepository;
import com.example.claims.temporal.LifeIntakeActivities.Facts;
import com.example.claims.temporal.LifeIntakeActivities.Payee;
import com.example.claims.temporal.LifeIntakeActivities.RouteDecision;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The database work behind the life intake activities: read the claim back, evaluate the rules that need
 * rows, send the first letters, and save the outcome in one transaction.
 */
@Service
public class IntakeSetupService {
    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final WorkflowRunRepository runs;
    private final HistoryRepository history;
    private final WorkItemRepository workItems;
    private final LetterService letters;
    private final BusinessCalendar calendar;
    private final Clock clock;

    public IntakeSetupService(JdbcClient jdbc, TransactionTemplate tx, WorkflowRunRepository runs, HistoryRepository history,
                              WorkItemRepository workItems, LetterService letters, BusinessCalendar calendar, Clock clock) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.runs = runs;
        this.history = history;
        this.workItems = workItems;
        this.letters = letters;
        this.calendar = calendar;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ reads

    public Facts loadFacts(UUID claimId) {
        record Head(String number, String status, String insured, String caller, LocalDate dod, boolean consent, List<String> contactBy) {}
        Head h = jdbc.sql("""
                SELECT c.claim_number, c.status, ip.full_name AS insured, cp.full_name AS caller, d.date_of_death, d.agent_consent, d.contact_by
                FROM claims c JOIN parties ip ON ip.id = c.insured_party_id
                JOIN life_claim_details d ON d.claim_id = c.id JOIN parties cp ON cp.id = d.caller_party_id
                WHERE c.id = :id""").param("id", claimId)
                .query((rs, i) -> new Head(rs.getString("claim_number"), rs.getString("status"), rs.getString("insured"), rs.getString("caller"),
                        Db.date(rs, "date_of_death"), rs.getBoolean("agent_consent"), Db.textArray(rs, "contact_by")))
                .single();
        List<Payee> payees = jdbc.sql("""
                SELECT p.id, p.full_name, p.email, COALESCE(cp.packet_channel, 'portal') AS packet
                FROM claim_parties cp JOIN parties p ON p.id = cp.party_id
                WHERE cp.claim_id = :id AND cp.role = 'beneficiary' AND cp.payee ORDER BY p.full_name""").param("id", claimId)
                .query((rs, i) -> new Payee(uuid(rs, "id"), rs.getString("full_name"), rs.getString("packet"), rs.getString("email"))).list();
        List<String> policies = jdbc.sql("SELECT DISTINCT pol.policy_number FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id WHERE b.claim_id = :id ORDER BY 1")
                .param("id", claimId).query(String.class).list();
        String agent = jdbc.sql("SELECT p.full_name FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = :id AND cp.role = 'agent_of_record' LIMIT 1")
                .param("id", claimId).query(String.class).optional().orElse(null);
        return new Facts(claimId, h.number(), h.status(), h.insured(), h.caller(), h.contactBy().contains("email"), payees, policies,
                h.dod().toString(), h.consent(), agent);
    }

    public List<String> duplicateClaims(UUID claimId) {
        return jdbc.sql("""
                SELECT other.claim_number FROM claims me
                JOIN parties mp ON mp.id = me.insured_party_id
                JOIN life_claim_details md ON md.claim_id = me.id
                JOIN claims other ON other.id <> me.id AND other.family = 'life' AND other.status <> 'closed'
                JOIN parties op ON op.id = other.insured_party_id
                JOIN life_claim_details od ON od.claim_id = other.id
                WHERE me.id = :id AND lower(op.full_name) = lower(mp.full_name) AND op.date_of_birth IS NOT DISTINCT FROM mp.date_of_birth
                  AND od.date_of_death = md.date_of_death
                ORDER BY other.claim_number""").param("id", claimId).query(String.class).list();
    }

    public RouteDecision route(UUID claimId) {
        record Base(String manner, boolean outside, boolean others, LocalDate noticeDate) {}
        Base b = jdbc.sql("SELECT d.manner_of_death, d.death_outside_us, d.other_claimants_possible, c.noticed_at FROM life_claim_details d JOIN claims c ON c.id = d.claim_id WHERE d.claim_id = :id")
                .param("id", claimId).query((rs, i) -> new Base(rs.getString(1), rs.getBoolean(2), rs.getBoolean(3), calendar.localDate(Db.instant(rs, "noticed_at")))).single();
        LocalDate dod = jdbc.sql("SELECT date_of_death FROM life_claim_details WHERE claim_id = :id").param("id", claimId)
                .query((rs, i) -> Db.date(rs, 1)).single();
        List<LocalDate> issues = jdbc.sql("SELECT DISTINCT pol.issue_date FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id WHERE b.claim_id = :id AND b.kind = 'base'")
                .param("id", claimId).query((rs, i) -> Db.date(rs, 1)).list();
        BigDecimal total = jdbc.sql("""
                SELECT COALESCE(sum(amount), 0) FROM benefit_lines WHERE claim_id = :id AND (kind = 'base' OR (kind = 'rider' AND :accident))""")
                .param("id", claimId).param("accident", b.manner().equals("accident")).query(BigDecimal.class).single();
        List<LocalDate> dobs = jdbc.sql("SELECT p.date_of_birth FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = :id AND cp.role = 'beneficiary' AND cp.payee")
                .param("id", claimId).query((rs, i) -> Db.date(rs, 1)).list();
        boolean past = issues.stream().allMatch(iss -> !dod.isBefore(LifeIntakeRules.twoYearsAfter(iss)));
        boolean adults = dobs.stream().allMatch(d -> LifeIntakeRules.isAdult(d, b.noticeDate()));
        LifeIntakeRules.Route r = LifeIntakeRules.route(new LifeIntakeRules.RouteFacts(b.manner(), past, total, adults, b.others(), b.outside()));

        // Least-loaded examiner. Real assignment (skills, out-of-office, capacity) replaces this.
        record Examiner(UUID id, String name) {}
        Optional<Examiner> ex = jdbc.sql("""
                SELECT s.id, s.display_name FROM staff_users s WHERE s.role = 'life_examiner' AND s.active
                ORDER BY (SELECT count(*) FROM claims c WHERE c.owner_id = s.id AND c.status <> 'closed'), s.handle LIMIT 1""")
                .query((rs, i) -> new Examiner(uuid(rs, 1), rs.getString(2))).optional();
        return new RouteDecision(r.track(), r.rule(), r.reasons(), ex.map(Examiner::id).orElse(null), ex.map(Examiner::name).orElse(null));
    }

    // ------------------------------------------------------------------ letters

    /** ACK-LIFE-01 to the caller and PKT-LIFE-02 to each payee. Each is sent once per claim, however often this runs. */
    public int sendAcknowledgementAndPackets(UUID claimId, String workflowId) {
        Facts f = loadFacts(claimId);
        int sent = 0;
        letters.sendOnce(new NewLetter(claimId, "ACK-LIFE-01", f.callerByEmail() ? "email" : "letter", null, f.callerName(),
                "Claim " + f.claimNumber() + " received", "Our condolences; what we need and what happens next",
                "outbox_event", null, workflowId, "intake:" + claimId + ":ack"), f.callerName());
        sent++;
        for (Payee p : f.payees()) {
            boolean mail = "mail".equals(p.packet());
            letters.sendOnce(new NewLetter(claimId, "PKT-LIFE-02", mail ? "letter" : "portal", p.partyId(), p.name(),
                    "Claim packet · " + LifeIntakeRules.first(p.name()),
                    "Claimant statement with W-9, how the proceeds are paid, and the death certificate we need",
                    "outbox_event", null, workflowId, "intake:" + claimId + ":packet:" + p.partyId()), p.name());
            sent++;
        }
        return sent;
    }

    public boolean tellAgent(UUID claimId, String workflowId) {
        Facts f = loadFacts(claimId);
        if (!f.agentConsent() || f.agentName() == null) return false;
        letters.sendOnce(new NewLetter(claimId, "AGT-NOTE-01", "email", null, f.agentName(), "A claim was filed on " + String.join(", ", f.policyNumbers()),
                "Status only, with the caller's consent", "outbox_event", null, workflowId, "intake:" + claimId + ":agent"), f.agentName());
        return true;
    }

    // ------------------------------------------------------------------ outcomes (one transaction each)

    public void completeSetup(UUID claimId, RouteDecision route, List<RunStep> steps, String workflowId, String runId) {
        tx.executeWithoutResult(s -> {
            Instant now = clock.instant();
            int moved = jdbc.sql("""
                    UPDATE claims SET status = 'gathering_evidence', track = :track, route_rule = :rule,
                           route_reasons = cast(:reasons as text[]), owner_id = :owner
                    WHERE id = :id AND status = 'received'""")
                    .param("track", route.track()).param("rule", route.rule()).param("reasons", Db.arrayLiteral(route.reasons()))
                    .param("owner", route.examinerId()).param("id", claimId).update();
            if (moved == 0) {   // a repeated call: the first one already did everything below
                runs.finish(workflowId, runId, "completed", steps, List.of("Already set up"), null, now);
                return;
            }
            List<UUID> closed = jdbc.sql("""
                    UPDATE deadlines SET state = 'done', closed_at = :now, closed_by = 'intake', last_outcome = 'closed_early',
                           result = 'Closed by the intake run when the acknowledgement and packets were sent; never had to fire'
                    WHERE claim_id = :id AND kind IN ('acknowledge_by', 'forms_by') AND state = 'open' RETURNING id""")
                    .param("now", Db.ts(now)).param("id", claimId).query((rs, i) -> uuid(rs, 1)).list();
            Instant contactDue = jdbc.sql("SELECT due_at FROM deadlines WHERE claim_id = :id AND kind = 'first_contact_by' ORDER BY due_at LIMIT 1")
                    .param("id", claimId).query((rs, i) -> Db.instant(rs, 1)).optional().orElse(now);
            Facts f = loadFacts(claimId);
            String first = LifeIntakeRules.first(f.callerName());
            String track = route.track().equals("fast_track_life") ? "Fast track life" : "Standard life";
            workItems.insertOnce("welcome-call:" + claimId, route.examinerId(), claimId, 2, "New life claim: welcome call to " + first,
                    "Phone intake · " + track + " · first contact due " + calendar.localDate(contactDue),
                    calendar.localDate(contactDue), "You", "workflow", "workflow", null);
            Actor wf = Actor.workflow(workflowId);
            history.append(claimId, now, "data", "Intake run " + workflowId + ": checks passed, claim set up", wf,
                    steps.size() + " steps · " + closed.size() + " deadline rows closed at once", null, workflowId);
            history.append(claimId, now, "task", "Routed " + track + " → " + (route.examinerName() == null ? "team queue" : route.examinerName()),
                    Actor.system("routing rule " + route.rule()), String.join(" · ", route.reasons()), null, workflowId);
            history.append(claimId, now, "communication", "Acknowledgement and claim packets sent", Actor.system("ACK-LIFE-01, PKT-LIFE-02"), null, null, workflowId);
            runs.finish(workflowId, runId, "completed", steps, List.of(
                    "Claim " + f.claimNumber() + " → gathering_evidence · " + route.rule(),
                    closed.size() + " deadline rows closed at once",
                    "Welcome-call work item for " + (route.examinerName() == null ? "the team queue" : route.examinerName())), null, now);
        });
    }

    public void holdForReview(UUID claimId, List<String> reasons, List<RunStep> steps, String workflowId, String runId) {
        tx.executeWithoutResult(s -> {
            Instant now = clock.instant();
            Facts f = loadFacts(claimId);
            workItems.insertOnce("intake-review:" + claimId, null, claimId, 1, "Intake checks need a person: " + f.claimNumber(),
                    String.join(" · ", reasons), calendar.localDate(now), "You", "workflow", "workflow", null);
            history.append(claimId, now, "task", "Intake checks stopped: " + reasons.size() + (reasons.size() == 1 ? " thing needs" : " things need") + " a person",
                    Actor.workflow(workflowId), String.join(" · ", reasons), null, workflowId);
            runs.finish(workflowId, runId, "needs_review", steps, List.of("Claim stays received", "Task opened in the team queue"), null, now);
        });
    }

    public void recordFailure(UUID claimId, String error, List<RunStep> steps, String workflowId, String runId) {
        tx.executeWithoutResult(s -> {
            Instant now = clock.instant();
            Facts f = loadFacts(claimId);
            workItems.insertOnce("workflow-failed:" + workflowId, null, claimId, 1, "Intake run failed: " + f.claimNumber(),
                    "Workflow " + workflowId + " gave up: " + error, calendar.localDate(now), "You", "workflow", "workflow", null);
            history.append(claimId, now, "task", "Intake run failed after retries", Actor.workflow(workflowId), error, null, workflowId);
            runs.finish(workflowId, runId, "failed", steps, List.of("Ops task opened"), error, now);
        });
    }

    public void beginRun(UUID claimId, UUID eventId, String workflowId, String runId) {
        runs.begin(workflowId, runId, "orchestration", "Intake checks and set-up", claimId,
                "Outbox relay · event " + eventId + " (notice of death saved)", "outbox_event", eventId, clock.instant());
    }
}
