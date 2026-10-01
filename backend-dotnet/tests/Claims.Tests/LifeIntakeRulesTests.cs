using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Tests.Support;

namespace Claims.Tests;

public class LifeIntakeRulesTests
{
    private readonly BusinessCalendar calendar = new(TimeZoneInfo.FindSystemTimeZoneById("America/Chicago"), new TimeOnly(8, 0));

    [Fact]
    public void NaturalDeathWithPrimaryGoneRequestsFourAndMeetsOneFromOurRecords()
    {
        var set = LifeIntakeRules.RequirementSet(TestData.Castellano("natural"));

        Assert.Equal(
            [RequirementKey.Certificate, RequirementKey.Statement, RequirementKey.Statement, RequirementKey.PrimaryDiedFirst],
            set.Select(p => p.Key));
        Assert.True(set[3].IsOnFile);
        Assert.Single(set, p => p.IsOnFile);
    }

    [Fact]
    public void AccidentAddsTheReportAndPendingAddsTheAmendedCertificateWithAThirtyDayFollowUp()
    {
        var accident = LifeIntakeRules.RequirementSet(TestData.Castellano("accident"));
        Assert.Contains(accident, p => p.Key == RequirementKey.Report);
        Assert.Equal(5, accident.Count);

        var pending = LifeIntakeRules.RequirementSet(TestData.Castellano("pending"));
        var amended = Assert.Single(pending, p => p.Key == RequirementKey.AmendedCertificate);
        Assert.Equal(30, amended.FollowUpDays);
    }

    [Fact]
    public void FirstDeadlinesMatchTheMockStorySevenRowsDueAtEightLocal()
    {
        var request = TestData.Castellano("natural");
        var set = LifeIntakeRules.RequirementSet(request);

        var rows = LifeIntakeRules.FirstDeadlines(request, set, TestData.NoticeAt, calendar);

        Assert.Equal(7, rows.Count);   // D-701..D-707 in the doc: ack, forms, first contact, status letter, 3 follow-ups
        Assert.Equal(
            [DeadlineKind.AcknowledgeBy, DeadlineKind.FormsBy, DeadlineKind.FirstContactBy, DeadlineKind.StatusLetter,
             DeadlineKind.RequirementFollowUp, DeadlineKind.RequirementFollowUp, DeadlineKind.RequirementFollowUp],
            rows.Select(r => r.Kind));
        // Notice Fri 25 Sep 10:03 CDT. Acknowledge: +15 days = Sat 10 Oct. First contact: next business day = Mon 28 Sep.
        Assert.Equal(DateTimeOffset.Parse("2026-10-10T13:00:00Z"), rows[0].DueAt);
        Assert.Equal(DateTimeOffset.Parse("2026-09-28T13:00:00Z"), rows[2].DueAt);
        Assert.Equal(DateTimeOffset.Parse("2026-10-25T13:00:00Z"), rows[3].DueAt);
        Assert.Equal(DateTimeOffset.Parse("2026-10-05T13:00:00Z"), rows[4].DueAt);   // follow-up +10 days = Mon 5 Oct
    }

    [Fact]
    public void BusinessDaysSkipWeekendsOnly()
    {
        Assert.Equal(new DateOnly(2026, 9, 28), BusinessCalendar.AddBusinessDays(new DateOnly(2026, 9, 25), 1));
        Assert.Equal(new DateOnly(2026, 10, 14), BusinessCalendar.AddBusinessDays(new DateOnly(2026, 10, 7), 5));
    }

    [Fact]
    public void RoutingFollowsLf01AndLf02()
    {
        var fast = LifeIntakeRules.RouteFor(new LifeIntakeRules.RouteFacts("natural", true, 200000.00m, true, false, false));
        Assert.Equal("LF-01", fast.Rule);
        Assert.Contains("Natural causes", fast.Reasons);
        Assert.Contains("Past the contestable period", fast.Reasons);
        Assert.Contains("$200,000 is within the $500,000 fast-track limit", fast.Reasons);

        var std = LifeIntakeRules.RouteFor(new LifeIntakeRules.RouteFacts("accident", true, 400000.00m, true, true, false));
        Assert.Equal("LF-02", std.Rule);
        Assert.Equal("standard_life", std.Track);
        Assert.Equal(["Accidental death: the rider needs a report", "Someone else may claim"], std.Reasons);

        Assert.Equal(
            ["Contestable policy", "$600,000 is above the $500,000 fast-track limit", "A beneficiary is a minor", "Death outside the US"],
            LifeIntakeRules.RouteFor(new LifeIntakeRules.RouteFacts("natural", false, 600000m, false, false, true)).Reasons);
    }
}
