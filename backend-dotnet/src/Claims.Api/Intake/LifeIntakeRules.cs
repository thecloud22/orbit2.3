using System.Globalization;
using Claims.Common;
using Claims.Domain;

namespace Claims.Intake;

/// <summary>
/// The rules that need nothing outside the request: who the payees are, which requirements to request,
/// which deadline rows to write. Rule values (15 and 30 days, 10-day follow-up, 30 for a medical examiner)
/// are the mock's examples; the real values come from product configuration and the state rules table by
/// effective date. Pure functions, so they are unit-tested without a database.
/// </summary>
public static class LifeIntakeRules
{
    public const int AckDays = 15;
    public const int FormsDays = 15;
    public const int StatusLetterDays = 30;
    public const int FollowUpDays = 10;
    public const int FollowUpDaysMedicalExaminer = 30;
    public const string ProductConfigVersion = "life-2026.1";

    public sealed record Payees(IReadOnlyList<Beneficiary> Members, bool PrimaryGone);

    /// <summary>Payees are the living primaries, or the living contingents when every primary died first.</summary>
    public static Payees PayeesOf(IReadOnlyList<Beneficiary> designation)
    {
        var primaryGone = designation.Where(b => b.Kind == "primary").All(b => b.DiedOn is not null);
        var kind = primaryGone ? "contingent" : "primary";
        return new Payees(designation.Where(b => b.DiedOn is null && b.Kind == kind).ToList(), primaryGone);
    }

    public sealed record PlannedRequirement(RequirementKey Key, string Name, string Purpose, string FromLabel, string FromDetail,
                                            int FollowUpDays, string? BeneficiaryRef, bool ForRider, string? OnFile)
    {
        public bool IsOnFile => OnFile is not null;
    }

    /// <summary>The requirement set: picked by manner of death and who the payees are.</summary>
    public static List<PlannedRequirement> RequirementSet(LifeIntakeRequest r)
    {
        var p = PayeesOf(r.Designation.Beneficiaries);
        var set = new List<PlannedRequirement>();
        var funeral = string.IsNullOrWhiteSpace(r.Death.FuneralHome) ? "from the county" : "the funeral home orders copies";
        set.Add(new PlannedRequirement(RequirementKey.Certificate, "Certified death certificate", "Proof of death",
            r.Caller.Name, "Mail or upload · " + funeral, FollowUpDays, null, false, null));
        foreach (var b in p.Members)
        {
            var mail = b.Contact is not null && b.Contact.Packet == "mail";
            set.Add(new PlannedRequirement(RequirementKey.Statement, "Claimant statement and W-9 · " + First(b.Name), "Proof of claim",
                b.Name, mail ? "Paper packet by mail" : "Portal · e-sign", FollowUpDays, b.Ref, false, null));
        }
        if (p.PrimaryGone)
        {
            var gone = r.Designation.Beneficiaries.First(b => b.Kind == "primary");
            set.Add(new PlannedRequirement(RequirementKey.PrimaryDiedFirst, "Proof " + gone.Name + " died first", "Beneficiary",
                "Our records", gone.DiedSource ?? "", 0, null, false,
                gone.DiedSource ?? "Death recorded on the designation"));
        }
        var manner = r.Death.Manner;
        if (manner == "accident")
        {
            set.Add(new PlannedRequirement(RequirementKey.Report, "Police or accident report", "Accidental death rider",
                "Investigating agency", "Records request by fax", FollowUpDays, null, true, null));
        }
        if (manner == "pending")
        {
            set.Add(new PlannedRequirement(RequirementKey.AmendedCertificate, "Amended certificate with final cause", "Cause of death",
                "Medical examiner", "Issued when the cause is final", FollowUpDaysMedicalExaminer, null, true, null));
        }
        return set;
    }

    public sealed record PlannedDeadline(DeadlineKind Kind, string What, string? Sla, DateTimeOffset DueAt, int RequirementIndex);

    /// <summary>The first deadline rows: three service levels that start at notice, plus one follow-up per open requirement.</summary>
    public static List<PlannedDeadline> FirstDeadlines(LifeIntakeRequest r, IReadOnlyList<PlannedRequirement> reqs, DateTimeOffset noticeAt, BusinessCalendar cal)
    {
        var caller = First(r.Caller.Name);
        var payeeNames = string.Join(" and ", PayeesOf(r.Designation.Beneficiaries).Members.Select(b => First(b.Name)));
        var output = new List<PlannedDeadline>
        {
            new(DeadlineKind.AcknowledgeBy, "Acknowledge the claim to " + caller, "ack", cal.DaysAfter(noticeAt, AckDays), -1),
            new(DeadlineKind.FormsBy, "Claim forms to " + payeeNames, "forms", cal.DaysAfter(noticeAt, FormsDays), -1),
            new(DeadlineKind.FirstContactBy, "Examiner calls " + caller, "contact", cal.BusinessDaysAfter(noticeAt, 1), -1),
            new(DeadlineKind.StatusLetter, "Status letter 1, if still undecided", "status", cal.DaysAfter(noticeAt, StatusLetterDays), -1),
        };
        for (var i = 0; i < reqs.Count; i++)
        {
            var q = reqs[i];
            if (!q.IsOnFile) output.Add(new PlannedDeadline(DeadlineKind.RequirementFollowUp, "Follow up: " + q.Name, null, cal.DaysAfter(noticeAt, q.FollowUpDays), i));
        }
        return output;
    }

    // ------------------------------------------------------------------ routing (LF-01 / LF-02)

    /// <summary>What routing needs, whether it comes from the request or from the rows the intake workflow reads back.</summary>
    public sealed record RouteFacts(string Manner, bool AllPastContestable, decimal TotalPayable, bool PayeesAdult, bool OtherClaimants, bool OutsideUs);

    public sealed record Route(string Track, string Rule, IReadOnlyList<string> Reasons);

    public const decimal FastTrackLimit = 500000m;

    /// <summary>Rules, not suggestions: the reasons are listed and logged.</summary>
    public static Route RouteFor(RouteFacts f)
    {
        var reasons = new List<string>();
        var blockers = new List<string>();
        if (f.Manner == "natural") reasons.Add("Natural causes");
        else blockers.Add(f.Manner == "accident" ? "Accidental death: the rider needs a report" : "Cause of death pending");
        if (f.AllPastContestable) reasons.Add("Past the contestable period"); else blockers.Add("Contestable policy");
        var money = "$" + ((long)decimal.Truncate(f.TotalPayable)).ToString("N0", CultureInfo.GetCultureInfo("en-US"));
        if (f.TotalPayable <= FastTrackLimit) reasons.Add(money + " is within the $500,000 fast-track limit");
        else blockers.Add(money + " is above the $500,000 fast-track limit");
        if (f.PayeesAdult) reasons.Add("Beneficiaries are adults"); else blockers.Add("A beneficiary is a minor");
        if (f.OtherClaimants) blockers.Add("Someone else may claim");
        if (f.OutsideUs) blockers.Add("Death outside the US");
        return blockers.Count == 0 ? new Route("fast_track_life", "LF-01", reasons) : new Route("standard_life", "LF-02", blockers);
    }

    /// <summary>Two years from issue: the contestable period and the suicide exclusion both end then.</summary>
    public static DateOnly TwoYearsAfter(DateOnly issue) => issue.AddYears(2);

    /// <summary>Whole years between two dates, as java.time.Period.between(...).getYears() counts them.</summary>
    public static bool IsAdult(DateOnly? dob, DateOnly on)
    {
        if (dob is null) return true;
        var d = dob.Value;
        var years = on.Year - d.Year;
        if (on.Month < d.Month || (on.Month == d.Month && on.Day < d.Day)) years--;
        return years >= 18;
    }

    public static bool AllPastContestable(IEnumerable<PolicyClaimed> policies, DateOnly dod) =>
        policies.All(p => dod >= TwoYearsAfter(p.Issued));

    public static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
