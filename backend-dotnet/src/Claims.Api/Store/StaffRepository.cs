using Claims.Common;

namespace Claims.Store;

/// <summary>Staff users: who may record and approve decisions, and up to how much. Authentication is not built; X-Actor names a handle.</summary>
public sealed class StaffRepository(Db db)
{
    public sealed record Staff(Guid Id, string Handle, string DisplayName, string Role, decimal PayoutLimit, string Team);

    private static readonly Func<DbRow, Staff> Map = r => new Staff(r.Guid("id"), r.Text("handle"), r.Text("display_name"), r.Text("role"),
        r.Decimal("payout_limit"), r.Text("team"));

    public Task<Staff?> FindActiveByHandleAsync(string handle) => db.QueryOptionalAsync(
        "SELECT id, handle, display_name, role, payout_limit, team FROM staff_users WHERE lower(handle) = lower(@h) AND active", new { h = handle }, Map);

    public Task<Staff?> FindAsync(Guid id) => db.QueryOptionalAsync(
        "SELECT id, handle, display_name, role, payout_limit, team FROM staff_users WHERE id = @id", new { id }, Map);

    /// <summary>The team lead who approves above an examiner's authority: the first active team lead of the claim's team.</summary>
    public Task<Staff?> TeamLeadForAsync(string team) => db.QueryOptionalAsync(
        "SELECT id, handle, display_name, role, payout_limit, team FROM staff_users WHERE role = 'team_lead' AND active AND team = @t ORDER BY handle LIMIT 1",
        new { t = team }, Map);
}
