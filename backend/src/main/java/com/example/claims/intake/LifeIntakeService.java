package com.example.claims.intake;

import static com.example.claims.common.Db.ts;
import static com.example.claims.common.Db.uuid;

import com.example.claims.common.Actor;
import com.example.claims.common.ApiException;
import com.example.claims.common.BusinessCalendar;
import com.example.claims.common.Db;
import com.example.claims.intake.LifeIntakeRequest.*;
import com.example.claims.intake.LifeIntakeRules.PlannedRequirement;
import com.example.claims.store.ClaimQueries;
import com.example.claims.store.DeadlineRepository;
import com.example.claims.store.DeadlineRepository.NewDeadline;
import com.example.claims.store.HistoryRepository;
import com.example.claims.store.OutboxRepository;
import com.example.claims.view.Views.ClaimView;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The synchronous half of life intake. ONE transaction saves the claim, its parties, policy snapshot,
 * benefit lines, requirements, the first deadline rows, history and an outbox event, then returns.
 * No workflow runs here: the outbox relay starts orch-&lt;claim&gt;-intake after the commit, and that
 * workflow does everything that talks to another system. (The mock does all of it inline.)
 */
@Service
public class LifeIntakeService {

    public record Result(ClaimView claim, boolean replayed) {}

    private final JdbcClient jdbc;
    private final ClaimQueries queries;
    private final DeadlineRepository deadlines;
    private final HistoryRepository history;
    private final OutboxRepository outbox;
    private final BusinessCalendar calendar;
    private final Clock clock;
    private final ObjectMapper json;

    public LifeIntakeService(JdbcClient jdbc, ClaimQueries queries, DeadlineRepository deadlines, HistoryRepository history,
                             OutboxRepository outbox, BusinessCalendar calendar, Clock clock, ObjectMapper json) {
        this.jdbc = jdbc;
        this.queries = queries;
        this.deadlines = deadlines;
        this.history = history;
        this.outbox = outbox;
        this.calendar = calendar;
        this.clock = clock;
        this.json = json;
    }

    @Transactional
    public Result submit(LifeIntakeRequest r, String idempotencyKey, Actor actor) {
        String scope = "life-intake:" + actor.name();
        String hash = hash(r);

        // Serialise concurrent requests with the same key, then replay or reject a repeat.
        jdbc.sql("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))) AS locked")
                .param("k", scope + "|" + idempotencyKey).query(Integer.class).single();
        record Seen(String hash, UUID claimId) {}
        Optional<Seen> seen = jdbc.sql("SELECT request_hash, claim_id FROM idempotency_keys WHERE scope = :s AND key = :k")
                .param("s", scope).param("k", idempotencyKey)
                .query((rs, i) -> new Seen(rs.getString("request_hash"), uuid(rs, "claim_id"))).optional();
        if (seen.isPresent()) {
            if (!seen.get().hash().equals(hash)) {
                throw ApiException.conflict("idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
            }
            return new Result(queries.claim(seen.get().claimId()).orElseThrow(), true);
        }

        Instant now = clock.instant();
        Instant noticeAt = r.noticeReceivedAt() != null ? r.noticeReceivedAt() : now;
        validate(r, noticeAt);

        LifeIntakeRules.Payees payees = LifeIntakeRules.payees(r.designation().beneficiaries());
        Insured insured = r.insured();

        // ---- parties
        UUID insuredId = party("person", insured.name(), insured.dateOfBirth(), r.death().dateOfDeath(), null, insured.ssnLast4(), null, null, null);
        Map<String, UUID> beneficiaryParty = new HashMap<>();
        for (Beneficiary b : r.designation().beneficiaries()) {
            Contact c = b.contact();
            beneficiaryParty.put(b.ref(), party("person", b.name(), b.dateOfBirth(), b.diedOn(), b.diedSource(), null,
                    c == null ? null : c.email(), c == null ? null : c.phone(), c == null ? null : c.address()));
        }
        Caller caller = r.caller();
        UUID callerId = caller.beneficiaryRef() != null
                ? beneficiaryParty.get(caller.beneficiaryRef())
                : party("person", caller.name(), null, null, null, null, caller.email(), caller.phone(), null);

        // ---- policy snapshot
        record PolicyRow(UUID id, PolicyClaimed p) {}
        List<PolicyRow> policies = r.policies().stream().map(p -> new PolicyRow(upsertPolicy(p, now), p)).toList();

        // ---- claim
        long seq = jdbc.sql("SELECT nextval('claim_number_seq')").query(Long.class).single();
        String claimNumber = "L-%02d-%06d".formatted(noticeAt.atZone(calendar.zone()).getYear() % 100, seq);
        UUID claimId = jdbc.sql("""
                INSERT INTO claims (claim_number, family, product_code, insured_party_id, status, noticed_at, created_by)
                VALUES (:n, 'life', :product, :insured, 'received', :noticed, :by) RETURNING id""")
                .param("n", claimNumber).param("product", policies.get(0).p().productCode()).param("insured", insuredId)
                .param("noticed", ts(noticeAt)).param("by", actor.kind() + ":" + actor.name())
                .query((rs, i) -> uuid(rs, "id")).single();

        Death d = r.death();
        jdbc.sql("""
                INSERT INTO life_claim_details (claim_id, date_of_death, place_of_death, manner_of_death, death_outside_us, funeral_home,
                    caller_party_id, caller_relationship, contact_by, identity_verified, agent_consent, other_claimants_possible)
                VALUES (:c, :dod, :place, :manner, :outside, :fh, :caller, :rel, cast(:contact as text[]), true, :consent, :others)""")
                .param("c", claimId).param("dod", d.dateOfDeath()).param("place", d.placeOfDeath()).param("manner", d.manner())
                .param("outside", d.outsideUs()).param("fh", blankToNull(d.funeralHome())).param("caller", callerId)
                .param("rel", caller.relationship()).param("contact", Db.arrayLiteral(caller.contactBy()))
                .param("consent", caller.agentConsent()).param("others", r.otherClaimantsPossible()).update();

        // ---- who is on the claim
        claimParty(claimId, insuredId, "insured", "Insured", null, null, false, null, null, "Died " + d.dateOfDeath());
        claimParty(claimId, insuredId, "owner", "Owner", null, null, false, null, null, null);
        claimParty(claimId, callerId, "caller", caller.relationship(), null, null, false, null, null, null);
        for (Beneficiary b : r.designation().beneficiaries()) {
            boolean payee = payees.payees().contains(b);
            String status = b.diedOn() != null ? "died " + b.diedOn() : payee ? "packet_sent_pending" : null;
            claimParty(claimId, beneficiaryParty.get(b.ref()), "beneficiary", b.relationship(), b.kind(), b.sharePercent(), payee,
                    b.contact() == null ? null : b.contact().packet(), b.diedSource(), status);
            if (payee && b.ref().equals(caller.beneficiaryRef())) {
                claimParty(claimId, beneficiaryParty.get(b.ref()), "claimant", b.relationship(), null, null, false, null, null, null);
            }
        }
        if (r.agent() != null) {
            UUID agentId = party("person", r.agent().name(), null, null, null, null, null, null, null);
            claimParty(claimId, agentId, "agent_of_record", "Agent of record", null, null, false, null,
                    caller.agentConsent() ? "Status only, with the caller's consent" : "None: caller declined", r.agent().agency());
        }
        if (d.funeralHome() != null && !d.funeralHome().isBlank()) {
            UUID fh = party("organisation", d.funeralHome().split(",")[0].trim(), null, null, null, null, null, null, null);
            claimParty(claimId, fh, "funeral_home", null, null, null, false, null, "No assignment filed", null);
        }

        // ---- benefit lines: the base coverage and each rider as its own line
        UUID firstBase = null;
        UUID firstRiderLine = null;
        for (PolicyRow pr : policies) {
            PolicyClaimed p = pr.p();
            UUID baseId = insertBenefitLine(claimId, pr.id(), "base", null, null, p.productName(), p.faceAmount().amount(), p.faceAmount().currency(),
                    "gathering_evidence", "Death certificate · claimant statements");
            if (firstBase == null) firstBase = baseId;
            for (Rider rd : p.riders() == null ? List.<Rider>of() : p.riders()) {
                String status = switch (d.manner()) {
                    case "accident" -> "gathering_evidence";
                    case "pending" -> "cause_pending";
                    default -> "not_payable";
                };
                UUID riderLine = insertBenefitLine(claimId, pr.id(), "rider", baseId, rd.key(), rd.name(), rd.amount().amount(),
                        rd.amount().currency(), status, status.equals("gathering_evidence") ? "Report" : status.equals("cause_pending") ? "Medical examiner" : null);
                if (firstRiderLine == null) firstRiderLine = riderLine;
            }
        }

        // ---- requirements (one row each) and the first deadlines
        List<PlannedRequirement> plan = LifeIntakeRules.requirementSet(r);
        UUID[] reqIds = new UUID[plan.size()];
        for (int i = 0; i < plan.size(); i++) {
            PlannedRequirement q = plan.get(i);
            UUID line = q.forRider() && firstRiderLine != null ? firstRiderLine : firstBase;
            UUID from = q.beneficiaryRef() != null ? beneficiaryParty.get(q.beneficiaryRef()) : q.key().db().equals("certificate") ? callerId : null;
            reqIds[i] = jdbc.sql("""
                    INSERT INTO requirements (claim_id, benefit_line_id, key, name, purpose, from_party_id, from_label, from_detail, state,
                                              requested_at, follow_up_days, accepted_at, received_at, satisfied_by)
                    VALUES (:c, :line, :key, :name, :purpose, :from, :label, :detail, :state, :at, :days, :accepted, :accepted, :by)
                    RETURNING id""")
                    .param("c", claimId).param("line", line).param("key", q.key().db()).param("name", q.name()).param("purpose", q.purpose())
                    .param("from", from).param("label", q.fromLabel()).param("detail", q.fromDetail())
                    .param("state", q.isOnFile() ? "accepted" : "requested").param("at", ts(noticeAt)).param("days", q.followUpDays())
                    .param("accepted", q.isOnFile() ? ts(noticeAt) : null).param("by", q.onFile())
                    .query((rs, i2) -> uuid(rs, "id")).single();
        }
        for (LifeIntakeRules.PlannedDeadline pd : LifeIntakeRules.firstDeadlines(r, plan, noticeAt, calendar)) {
            deadlines.insert(new NewDeadline(claimId, pd.kind(), pd.requirementIndex() >= 0 ? reqIds[pd.requirementIndex()] : null,
                    pd.what(), pd.sla(), pd.dueAt()));
        }

        // ---- history and the outbox event, same transaction
        String first = LifeIntakeRules.first(insured.name());
        Actor who = actor;
        history.append(claimId, noticeAt, "access", "Caller confirmed " + first + "'s date of birth and policy number", who,
                "Caller: " + caller.name(), null, null);
        history.append(claimId, noticeAt, "data", "Notice of death saved · event to the outbox", who,
                "Died " + d.dateOfDeath() + " · " + d.manner(), null, null);
        outbox.insert(claimId, "notice_of_death_received", payload(Map.of("claimId", claimId.toString(), "claimNumber", claimNumber)));

        jdbc.sql("INSERT INTO idempotency_keys (scope, key, request_hash, claim_id) VALUES (:s, :k, :h, :c)")
                .param("s", scope).param("k", idempotencyKey).param("h", hash).param("c", claimId).update();

        return new Result(queries.claim(claimId).orElseThrow(), false);
    }

    // ------------------------------------------------------------------ validation

    private void validate(LifeIntakeRequest r, Instant noticeAt) {
        Caller c = r.caller();
        if (!c.verifiedDateOfBirth() || !c.verifiedPolicyNumber()) {
            throw ApiException.unprocessable("identity_not_verified", "The caller's date of birth and policy number must both be confirmed before submit");
        }
        if (r.death().dateOfDeath().isAfter(calendar.localDate(noticeAt))) {
            throw ApiException.unprocessable("date_of_death_in_future", "The date of death is after the notice date");
        }
        Set<String> refs = new HashSet<>();
        for (Beneficiary b : r.designation().beneficiaries()) {
            if (!refs.add(b.ref())) throw ApiException.unprocessable("duplicate_beneficiary_ref", "Beneficiary ref " + b.ref() + " is used twice");
        }
        if (c.beneficiaryRef() != null && !refs.contains(c.beneficiaryRef())) {
            throw ApiException.unprocessable("unknown_beneficiary_ref", "caller.beneficiaryRef does not match a designated beneficiary");
        }
        List<Beneficiary> payees = LifeIntakeRules.payees(r.designation().beneficiaries()).payees();
        if (payees.isEmpty()) {
            throw ApiException.unprocessable("no_payees", "No living beneficiary is designated; this needs a person to look at it");
        }
        BigDecimal shares = payees.stream().map(Beneficiary::sharePercent).reduce(BigDecimal.ZERO, BigDecimal::add);
        if (shares.compareTo(new BigDecimal("100")) != 0) {
            throw ApiException.unprocessable("payee_shares_invalid", "The payees' shares add up to " + shares.stripTrailingZeros().toPlainString() + "%, not 100%");
        }
        for (PolicyClaimed p : r.policies()) {
            if (p.inForce() != (p.lapsedOn() == null)) {
                throw ApiException.unprocessable("policy_lapse_inconsistent", "Policy " + p.policyNumber() + ": inForce and lapsedOn disagree");
            }
            boolean usd = p.faceAmount().currency().equals("USD")
                    && (p.riders() == null || p.riders().stream().allMatch(x -> x.amount().currency().equals("USD")));
            if (!usd) throw ApiException.unprocessable("currency_not_supported", "Only USD is supported");
        }
    }

    // ------------------------------------------------------------------ inserts

    private UUID party(String kind, String name, LocalDate dob, LocalDate died, String deathSource, String ssn,
                       String email, String phone, String address) {
        return jdbc.sql("""
                INSERT INTO parties (kind, full_name, date_of_birth, date_of_death, death_source, ssn_last4, email, phone, address)
                VALUES (:kind, :name, :dob, :died, :src, :ssn, :email, :phone, :address) RETURNING id""")
                .param("kind", kind).param("name", name).param("dob", dob).param("died", died).param("src", deathSource)
                .param("ssn", ssn).param("email", blankToNull(email)).param("phone", blankToNull(phone)).param("address", blankToNull(address))
                .query((rs, i) -> uuid(rs, "id")).single();
    }

    private void claimParty(UUID claimId, UUID partyId, String role, String relationship, String beneficiaryKind, BigDecimal share,
                            boolean payee, String packet, String accessNote, String status) {
        jdbc.sql("""
                INSERT INTO claim_parties (claim_id, party_id, role, relationship, beneficiary_kind, share_percent, payee, packet_channel, access_note, status)
                VALUES (:c, :p, :role, :rel, :kind, :share, :payee, :packet, :note, :status)
                ON CONFLICT DO NOTHING""")
                .param("c", claimId).param("p", partyId).param("role", role).param("rel", relationship).param("kind", beneficiaryKind)
                .param("share", share).param("payee", payee).param("packet", packet).param("note", accessNote).param("status", status).update();
    }

    private UUID upsertPolicy(PolicyClaimed p, Instant now) {
        UUID id = jdbc.sql("""
                INSERT INTO policies (policy_number, family, product_code, product_name, issue_date, paid_to_date, in_force, lapsed_on, face_amount, currency, as_of)
                VALUES (:num, 'life', :code, :name, :issue, :paid, :inforce, :lapsed, :face, :cur, :now)
                ON CONFLICT (policy_number) DO UPDATE SET product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name,
                    issue_date = EXCLUDED.issue_date, paid_to_date = EXCLUDED.paid_to_date, in_force = EXCLUDED.in_force,
                    lapsed_on = EXCLUDED.lapsed_on, face_amount = EXCLUDED.face_amount, as_of = EXCLUDED.as_of
                RETURNING id""")
                .param("num", p.policyNumber()).param("code", p.productCode()).param("name", p.productName()).param("issue", p.issueDate())
                .param("paid", p.paidToDate()).param("inforce", p.inForce()).param("lapsed", p.lapsedOn())
                .param("face", new BigDecimal(p.faceAmount().amount())).param("cur", p.faceAmount().currency()).param("now", ts(now))
                .query((rs, i) -> uuid(rs, "id")).single();
        for (Rider rd : p.riders() == null ? List.<Rider>of() : p.riders()) {
            jdbc.sql("""
                    INSERT INTO policy_riders (policy_id, rider_key, name, amount) VALUES (:p, :k, :n, :a)
                    ON CONFLICT (policy_id, rider_key) DO UPDATE SET name = EXCLUDED.name, amount = EXCLUDED.amount""")
                    .param("p", id).param("k", rd.key()).param("n", rd.name()).param("a", new BigDecimal(rd.amount().amount())).update();
        }
        return id;
    }

    private UUID insertBenefitLine(UUID claimId, UUID policyId, String kind, UUID parent, String riderKey, String name, String amount,
                                   String currency, String status, String waitingOn) {
        return jdbc.sql("""
                INSERT INTO benefit_lines (claim_id, policy_id, kind, parent_line_id, rider_key, name, amount, currency, status, waiting_on, product_config_version)
                VALUES (:c, :pol, :kind, :parent, :rk, :name, :amount, :cur, :status, :waiting, :ver) RETURNING id""")
                .param("c", claimId).param("pol", policyId).param("kind", kind).param("parent", parent).param("rk", riderKey)
                .param("name", name).param("amount", new BigDecimal(amount)).param("cur", currency).param("status", status)
                .param("waiting", waitingOn).param("ver", LifeIntakeRules.PRODUCT_CONFIG_VERSION)
                .query((rs, i) -> uuid(rs, "id")).single();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private String payload(Map<String, String> m) {
        try {
            return json.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private String hash(LifeIntakeRequest r) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(json.writeValueAsString(r).getBytes(StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException | JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
