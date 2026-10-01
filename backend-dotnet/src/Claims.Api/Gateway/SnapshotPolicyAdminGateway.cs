using Claims.Common;

namespace Claims.Gateway;

/// <summary>
/// STUB. Answers from the policy snapshot saved at intake instead of calling policy administration.
/// The rule is the mock's: in force on the date of death when premium is paid to within a 31-day grace period.
/// Replace with a real client (with its own timeouts and Temporal retry policy).
/// </summary>
public sealed class SnapshotPolicyAdminGateway(Db db) : IPolicyAdminGateway
{
    private const int GraceDays = 31;

    private sealed record Snap(DateOnly PaidTo, bool InForce);

    public async Task<PolicyStatus> StatusOnAsync(string policyNumber, DateOnly dod)
    {
        var s = await db.QuerySingleAsync("SELECT paid_to_date, in_force FROM policies WHERE policy_number = @n", new { n = policyNumber },
            r => new Snap(r.Date("paid_to_date"), r.Bool("in_force")));
        var inForce = s.InForce && dod <= s.PaidTo.AddDays(GraceDays);
        return new PolicyStatus(policyNumber, inForce, s.PaidTo,
            inForce ? $"premium paid to {s.PaidTo:yyyy-MM-dd}"
            : s.InForce ? $"premium paid only to {s.PaidTo:yyyy-MM-dd}, past the grace period" : "policy lapsed");
    }
}
