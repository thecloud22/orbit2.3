using Claims.Intake;
using Claims.View;

namespace Claims.Tests.Support;

/// <summary>The mock's story: Robert Castellano, 71, died Sat 19 Sep 2026; Diane calls Fri 25 Sep 10:03 (Central).</summary>
public static class TestData
{
    public static readonly DateTimeOffset NoticeAt = DateTimeOffset.Parse("2026-09-25T15:03:00Z", System.Globalization.CultureInfo.InvariantCulture);

    public static LifeIntakeRequest Castellano(string manner) => Castellano(manner, "WL-0804419", "Robert Castellano", true);

    public static LifeIntakeRequest Castellano(string manner, string policyNumber, string insuredName, bool agentConsent) => new(
        NoticeAt,
        new CallerInfo("Diane Castellano", "Child", "612-555-0117", "diane@example.com", ["email", "text"], true, true, agentConsent, "diane"),
        new InsuredInfo(insuredName, new DateOnly(1955, 3, 2), "4419"),
        new DeathInfo(new DateOnly(2026, 9, 19), "At home, Two Harbors, MN", manner, false, "Lakeshore Funeral Chapel, Two Harbors"),
        [new PolicyClaimed(policyNumber, "WL", "Whole life", new DateOnly(2008, 5, 1), new DateOnly(2026, 9, 1), true, null,
            new Money("200000.00", "USD"), [new Rider("adb", "Accidental death rider", new Money("200000.00", "USD"))])],
        new DesignationInfo(new DateOnly(2015, 3, 3), "Designation on file",
        [
            new Beneficiary("linda", "Linda Castellano", "Spouse", "primary", 100m, null, new DateOnly(2021, 6, 12), "Death certificate on file from her own claim", null),
            new Beneficiary("diane", "Diane Castellano", "Child", "contingent", 50m, new DateOnly(1984, 7, 9), null, null,
                new Contact("612-555-0117", "diane@example.com", "1 Lake Rd, Two Harbors, MN", "portal")),
            new Beneficiary("mark", "Mark Castellano", "Child", "contingent", 50m, new DateOnly(1987, 1, 21), null, null,
                new Contact("612-555-0142", "mark@example.com", "9 Pine St, Duluth, MN", "portal")),
        ]),
        new AgentInfo("Tom Bright", "Northwoods Agency"),
        false);

    /// <summary>A policy number that is new on every call, so tests sharing a database do not collide.</summary>
    public static string NewPolicy() => "WL-" + Guid.NewGuid().ToString()[..8];
}
