package com.example.claims.intake;

import com.example.claims.common.BusinessCalendar;
import com.example.claims.domain.DeadlineKind;
import com.example.claims.domain.RequirementKey;
import com.example.claims.intake.LifeIntakeRequest.Beneficiary;
import com.example.claims.intake.LifeIntakeRequest.PolicyClaimed;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Period;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The rules that need nothing outside the request: who the payees are, which requirements to request,
 * which deadline rows to write. Rule values (15 and 30 days, 10-day follow-up, 30 for a medical examiner)
 * are the mock's examples; the real values come from product configuration and the state rules table by
 * effective date. Pure functions, so they are unit-tested without a database.
 */
public final class LifeIntakeRules {
    private LifeIntakeRules() {}

    public static final int ACK_DAYS = 15;
    public static final int FORMS_DAYS = 15;
    public static final int STATUS_LETTER_DAYS = 30;
    public static final int FOLLOW_UP_DAYS = 10;
    public static final int FOLLOW_UP_DAYS_MEDICAL_EXAMINER = 30;
    public static final String PRODUCT_CONFIG_VERSION = "life-2026.1";

    public record Payees(List<Beneficiary> payees, boolean primaryGone) {}

    /** Payees are the living primaries, or the living contingents when every primary died first. */
    public static Payees payees(List<Beneficiary> designation) {
        boolean primaryGone = designation.stream().filter(b -> b.kind().equals("primary")).allMatch(b -> b.diedOn() != null);
        String kind = primaryGone ? "contingent" : "primary";
        return new Payees(designation.stream().filter(b -> b.diedOn() == null && b.kind().equals(kind)).toList(), primaryGone);
    }

    public record PlannedRequirement(RequirementKey key, String name, String purpose, String fromLabel, String fromDetail,
                                     int followUpDays, String beneficiaryRef, boolean forRider, String onFile) {
        public boolean isOnFile() { return onFile != null; }
    }

    /** The requirement set: picked by manner of death and who the payees are. */
    public static List<PlannedRequirement> requirementSet(LifeIntakeRequest r) {
        Payees p = payees(r.designation().beneficiaries());
        List<PlannedRequirement> set = new ArrayList<>();
        String funeral = r.death().funeralHome() == null || r.death().funeralHome().isBlank() ? "from the county" : "the funeral home orders copies";
        set.add(new PlannedRequirement(RequirementKey.CERTIFICATE, "Certified death certificate", "Proof of death",
                r.caller().name(), "Mail or upload · " + funeral, FOLLOW_UP_DAYS, null, false, null));
        for (Beneficiary b : p.payees()) {
            boolean mail = b.contact() != null && "mail".equals(b.contact().packet());
            set.add(new PlannedRequirement(RequirementKey.STATEMENT, "Claimant statement and W-9 · " + first(b.name()), "Proof of claim",
                    b.name(), mail ? "Paper packet by mail" : "Portal · e-sign", FOLLOW_UP_DAYS, b.ref(), false, null));
        }
        if (p.primaryGone()) {
            Beneficiary gone = r.designation().beneficiaries().stream().filter(b -> b.kind().equals("primary")).findFirst().orElseThrow();
            set.add(new PlannedRequirement(RequirementKey.PRIMARY_DIED_FIRST, "Proof " + gone.name() + " died first", "Beneficiary",
                    "Our records", gone.diedSource() == null ? "" : gone.diedSource(), 0, null, false,
                    gone.diedSource() == null ? "Death recorded on the designation" : gone.diedSource()));
        }
        String manner = r.death().manner();
        if (manner.equals("accident")) {
            set.add(new PlannedRequirement(RequirementKey.REPORT, "Police or accident report", "Accidental death rider",
                    "Investigating agency", "Records request by fax", FOLLOW_UP_DAYS, null, true, null));
        }
        if (manner.equals("pending")) {
            set.add(new PlannedRequirement(RequirementKey.AMENDED_CERTIFICATE, "Amended certificate with final cause", "Cause of death",
                    "Medical examiner", "Issued when the cause is final", FOLLOW_UP_DAYS_MEDICAL_EXAMINER, null, true, null));
        }
        return set;
    }

    public record PlannedDeadline(DeadlineKind kind, String what, String sla, Instant dueAt, int requirementIndex) {}

    /** The first deadline rows: three service levels that start at notice, plus one follow-up per open requirement. */
    public static List<PlannedDeadline> firstDeadlines(LifeIntakeRequest r, List<PlannedRequirement> reqs, Instant noticeAt, BusinessCalendar cal) {
        String caller = first(r.caller().name());
        String payeeNames = String.join(" and ", payees(r.designation().beneficiaries()).payees().stream().map(b -> first(b.name())).toList());
        List<PlannedDeadline> out = new ArrayList<>();
        out.add(new PlannedDeadline(DeadlineKind.ACKNOWLEDGE_BY, "Acknowledge the claim to " + caller, "ack", cal.daysAfter(noticeAt, ACK_DAYS), -1));
        out.add(new PlannedDeadline(DeadlineKind.FORMS_BY, "Claim forms to " + payeeNames, "forms", cal.daysAfter(noticeAt, FORMS_DAYS), -1));
        out.add(new PlannedDeadline(DeadlineKind.FIRST_CONTACT_BY, "Examiner calls " + caller, "contact", cal.businessDaysAfter(noticeAt, 1), -1));
        out.add(new PlannedDeadline(DeadlineKind.STATUS_LETTER, "Status letter 1, if still undecided", "status", cal.daysAfter(noticeAt, STATUS_LETTER_DAYS), -1));
        for (int i = 0; i < reqs.size(); i++) {
            PlannedRequirement q = reqs.get(i);
            if (!q.isOnFile()) {
                out.add(new PlannedDeadline(DeadlineKind.REQUIREMENT_FOLLOW_UP, "Follow up: " + q.name(), null, cal.daysAfter(noticeAt, q.followUpDays()), i));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ routing (LF-01 / LF-02)

    /** What routing needs, whether it comes from the request or from the rows the intake workflow reads back. */
    public record RouteFacts(String manner, boolean allPastContestable, BigDecimal totalPayable, boolean payeesAdult,
                             boolean otherClaimants, boolean outsideUs) {}

    public record Route(String track, String rule, List<String> reasons) {}

    public static final BigDecimal FAST_TRACK_LIMIT = new BigDecimal("500000");

    /** Rules, not suggestions: the reasons are listed and logged. */
    public static Route route(RouteFacts f) {
        List<String> reasons = new ArrayList<>();
        List<String> blockers = new ArrayList<>();
        if (f.manner().equals("natural")) reasons.add("Natural causes");
        else blockers.add(f.manner().equals("accident") ? "Accidental death: the rider needs a report" : "Cause of death pending");
        if (f.allPastContestable()) reasons.add("Past the contestable period"); else blockers.add("Contestable policy");
        String money = "$" + String.format(Locale.US, "%,d", f.totalPayable().setScale(0, java.math.RoundingMode.DOWN).longValue());
        if (f.totalPayable().compareTo(FAST_TRACK_LIMIT) <= 0) reasons.add(money + " is within the $500,000 fast-track limit");
        else blockers.add(money + " is above the $500,000 fast-track limit");
        if (f.payeesAdult()) reasons.add("Beneficiaries are adults"); else blockers.add("A beneficiary is a minor");
        if (f.otherClaimants()) blockers.add("Someone else may claim");
        if (f.outsideUs()) blockers.add("Death outside the US");
        return blockers.isEmpty() ? new Route("fast_track_life", "LF-01", reasons) : new Route("standard_life", "LF-02", blockers);
    }

    /** Two years from issue: the contestable period and the suicide exclusion both end then. */
    public static LocalDate twoYearsAfter(LocalDate issue) {
        return issue.plusYears(2);
    }

    public static boolean isAdult(LocalDate dob, LocalDate on) {
        return dob == null || Period.between(dob, on).getYears() >= 18;
    }

    public static boolean allPastContestable(List<PolicyClaimed> policies, LocalDate dod) {
        return policies.stream().allMatch(p -> !dod.isBefore(twoYearsAfter(p.issueDate())));
    }

    public static String first(String name) {
        int i = name.indexOf(' ');
        return i < 0 ? name : name.substring(0, i);
    }
}
